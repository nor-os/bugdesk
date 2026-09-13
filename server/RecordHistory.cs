using System.Text.RegularExpressions;

/// <summary>
/// One line of a record's <c>## History</c> section.
/// </summary>
/// <param name="Field">status | assignee | reporter — "" for a free-text note.</param>
record HistoryEntry(string Date, string Actor, string Field, string From, string To, string Note);

/// <summary>One field's before/after, as a patch handler observes it.</summary>
record FieldChange(string Field, string From, string To);

/// <summary>
/// The record's own audit trail: one line per tracked transition, oldest first,
/// append-only, strictly above <c>## Comments</c>.
/// <para>
/// Three fields are recorded and no others, because a severity or title edit is a
/// diff and an audit trail is for decisions. Nothing rewrites or re-orders an
/// existing line: a person reads this section in a commit diff, and a line that
/// moves is a line they have to re-read.
/// </para>
/// </summary>
static class RecordHistory
{
    public const string Heading = "## History";
    public const string Unset   = "(unset)";

    /// <summary>
    /// <c>- date · actor · rest</c>. The leading bullet is not decoration:
    /// <see cref="Md.GetFrontmatter"/> and <see cref="Md.SetFrontmatter"/> both match
    /// <c>^key:</c> over the WHOLE document, so a line written flush-left as
    /// <c>status: open -&gt; investigation</c> would be read as the record's status and
    /// then overwritten by the next patch. The actor class allows <c>_</c>
    /// deliberately — excluding it is precisely the <see cref="Md.CommentHdr"/> bug
    /// this release fixes. Keep this pattern free of double-quote characters: the
    /// drift test lifts it out of this source file and runs it.
    /// </summary>
    public static readonly Regex EntryLine =
        new(@"^\s*[-*]\s+(?<date>\S+)\s*·\s*(?<actor>[^\r\n·]+?)\s*·\s*(?<rest>\S[^\r\n]*?)\s*$",
            RegexOptions.None);

    /// <summary>
    /// <c>field: from -&gt; to</c>. <c>from</c> is greedy so it binds the LAST arrow,
    /// which is how a person reads a value that contains one: <c>status: a -&gt; b -&gt; c</c>
    /// went from "a -&gt; b" to "c".
    /// </summary>
    static readonly Regex Change =
        new(@"^(?<field>[A-Za-z][A-Za-z0-9_-]*)\s*:\s*(?<from>.*)\s*(?:->|→)\s*(?<to>[^\r\n]*?)\s*$",
            RegexOptions.None);

    static readonly Regex Placeholder =
        new(@"^_\(.*\)_$",
            RegexOptions.None);

    static readonly Regex Bullet =
        new(@"^[-*]\s*",
            RegexOptions.None);

    /// <summary>
    /// The whole definition of what a history records. One line, array-initialiser
    /// braces, three quoted strings and nothing else: <c>scripts/test-ui.mjs</c>
    /// lifts this line out of the source to pin the UI's copy against it, and any
    /// other shape either throws there or silently lifts the wrong thing.
    /// </summary>
    public static readonly string[] Fields = { "status", "assignee", "reporter" };

    public static bool Tracked(string key) => Array.IndexOf(Fields, key) >= 0;

    /// <summary>Where a field sorts when one save changes several of them.</summary>
    public static int Order(string key) => Math.Max(0, Array.IndexOf(Fields, key));

    public static string Line(string date, string actor, FieldChange c) =>
        $"- {date} · {actor.Trim()} · {c.Field}: {Show(c.From)} -> {Show(c.To)}";

    /// <summary>An empty side is written as the literal <c>(unset)</c>: a line ending in
    /// "-&gt; " is not a line, and the sentinel reads correctly in a diff.</summary>
    static string Show(string? v) => string.IsNullOrWhiteSpace(v) ? Unset : v.Trim();

    /// <summary>The inverse of <see cref="Show"/> — the sentinel is file-format only,
    /// and the JSON carries "".</summary>
    static string Hide(string? v) { var s = (v ?? "").Trim(); return s == Unset ? "" : s; }

    /// <summary>
    /// Read the section, line by line. A non-blank, non-heading, non-placeholder line
    /// the entry pattern rejects comes back as a NOTE rather than as nothing:
    /// silently dropping a line a person can read is the exact failure class the
    /// comment-header fix in this release exists to end.
    /// </summary>
    public static List<HistoryEntry> Parse(string? section)
    {
        var rows = new List<HistoryEntry>();
        foreach (var raw in (section ?? "").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith("#", StringComparison.Ordinal)) continue;   // a heading
            if (Placeholder.IsMatch(line)) continue;                        // "_(nothing yet)_"
            var m = EntryLine.Match(line);
            if (!m.Success)
            {
                rows.Add(new HistoryEntry("", "", "", "", "", Bullet.Replace(line, "").Trim()));
                continue;
            }
            var date  = m.Groups["date"].Value;
            var actor = m.Groups["actor"].Value.Trim();
            var rest  = m.Groups["rest"].Value.Trim();
            var c = Change.Match(rest);
            var field = c.Success ? c.Groups["field"].Value.ToLowerInvariant() : "";
            rows.Add(c.Success && Tracked(field)
                ? new HistoryEntry(date, actor, field, Hide(c.Groups["from"].Value), Hide(c.Groups["to"].Value), "")
                : new HistoryEntry(date, actor, "", "", "", rest));
        }
        return rows;
    }

    /// <summary>
    /// The ONLY writer. Splice, not rebuild: the section is hand-authored markdown,
    /// and regenerating it from parsed entries would reflow lines a person wrote —
    /// the same argument <see cref="Md.EditChecklist"/> already makes. It never bumps
    /// <c>updated</c>; every caller already does, and a second bump is a second place
    /// to forget.
    /// </summary>
    public static string Append(string text, string actor, IEnumerable<FieldChange> changes)
    {
        var rows = changes.Where(c => (c.From ?? "").Trim() != (c.To ?? "").Trim())
                          .OrderBy(c => Order(c.Field)).ToList();
        if (rows.Count == 0) return text;            // a history of no-ops hides the real changes
        var date  = Md.Today();
        var added = string.Concat(rows.Select(c => Line(date, actor, c) + "\n"));

        // Search ONLY above the comment thread. Md.SetSection searches the whole
        // document, which would splice into a comment that happened to quote
        // "## History" — and the parsers, which read ContentBlock, would never see
        // what was written there.
        var ci   = text.IndexOf("## Comments", StringComparison.Ordinal);
        var head = ci < 0 ? text : text[..ci];
        var at   = head.IndexOf(Heading, StringComparison.OrdinalIgnoreCase);

        if (at < 0)
        {
            var block = Heading + "\n\n" + added;
            return ci >= 0 ? text[..ci] + block + "\n" + text[ci..]
                           : text.TrimEnd() + "\n\n" + block;
        }

        var bodyStart = at + Heading.Length;
        var next      = Md.NextH2Index(text, bodyStart);
        var bodyEnd   = next < 0 ? text.Length : next;
        // Trim BOTH ends, not just the tail: the leading "\n\n" a previous append
        // wrote lives inside `body`, and the return below prepends another — two
        // blank lines per transition, without bound, in a file read as a diff.
        var body      = text[bodyStart..bodyEnd].Trim();
        if (Placeholder.IsMatch(body)) body = "";
        var kept = body.Length == 0 ? "" : body + "\n";
        return text[..bodyStart] + "\n\n" + kept + added + (next < 0 ? "" : "\n") + text[bodyEnd..];
    }
}
