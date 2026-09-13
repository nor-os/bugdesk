using System.Text.RegularExpressions;

/// <summary>
/// One comment in a record's <c>## Comments</c> section.
/// </summary>
record Comment(string Date, string Author, string Body);

/// <summary>
/// Shared plumbing for BugDesk's record format: YAML-ish frontmatter, a body of
/// <c>## Heading</c> sections, and a <c>## Comments</c> thread.
/// <para>
/// Both stores use it — <see cref="Bug"/> over <c>bugs/BUG-NNNN.md</c> and
/// <see cref="BacklogItem"/> over <c>backlog/{EPIC,STORY,TASK}-NNNN.md</c>. The
/// two record types differ in their FIELDS, not in how a file is shaped, so the
/// shaping lives here once and neither store re-derives it.
/// </para>
/// </summary>
static class Md
{
    public static string Today() => DateTime.UtcNow.ToString("yyyy-MM-dd");

    /// <summary>
    /// "### 2026-07-27 · agent", optionally followed by a parenthetical note and/or the
    /// <c>_(imported)_</c> marker. The author stops at '(' deliberately: a header written as
    /// "· agent (fixed)" used to parse its author as the whole string "agent (fixed)", which is
    /// not "agent", so the record silently vanished from the "Needs my reply" filter with nothing
    /// anywhere reporting a problem. Authors are free-form strings (see BUGDESK_HUMAN/BUGDESK_AGENT
    /// in the README); anything after the name is a note, not part of the identity.
    /// <para>
    /// The class also used to exclude <c>_</c>. The cost was that an author with an underscore in
    /// their name — <c>hans_agent</c>, which is exactly the shape <c>ProjectConfig.AgentNameFor</c>
    /// generates — made the whole header fail to match, so the comment was folded into the previous
    /// one's body, the record's comment count was wrong, and it dropped out of "Needs my reply" with
    /// nothing reporting a problem. The lazy quantifier, not the character class, is what stops the
    /// author eating the <c>_(imported)_</c> marker; backtracking covers every documented case.
    /// Keep this pattern free of double-quote characters — <c>scripts/test-ui.mjs</c> lifts it out
    /// of this source file and runs it, because nothing else executes it.
    /// </para>
    /// </summary>
    public static readonly Regex CommentHdr =
        new(@"^###\s+(?<date>\S+)\s+·\s+(?<author>[^\r\n(]+?)\s*(?:\([^)\r\n]*\))?\s*(?:_\(imported\)_)?\s*$",
            RegexOptions.Multiline);

    /// <summary>
    /// Read one frontmatter value, or null when the key is absent.
    /// <para>
    /// The gap after the colon is <c>[ \t]*</c> and NOT <c>\s*</c>, because
    /// <c>\s</c> matches a newline: on a key written with an empty value —
    /// <c>assignee:</c>, which <see cref="Line"/> deliberately emits and which
    /// hand-written records carry — a <c>\s*</c> would step over the line break
    /// and return the FOLLOWING line's text as the value. That is not a cosmetic
    /// misread: the value is used as the "from" side of a <c>## History</c> entry
    /// and as the existing-links list a duplicate-of merge appends to, so an
    /// empty <c>assignee:</c> produced history lines reading
    /// "assignee: reporter: -&gt; hans" and wrote a fabricated
    /// "created: 2026-09-01" into a record's links.
    /// </para>
    /// </summary>
    public static string? GetFrontmatter(string text, string key)
    {
        var m = new Regex($@"(?m)^{Regex.Escape(key)}:[ \t]*(.*)$").Match(text);
        return m.Success ? m.Groups[1].Value.Trim().Trim('"') : null;
    }

    /// <summary>
    /// Set (or insert) one frontmatter value, leaving the rest of the file byte-identical.
    /// An absent key is inserted just before the closing <c>---</c>.
    /// <para>
    /// The replacement goes in through a <see cref="MatchEvaluator"/>, not as a
    /// pattern string: a title containing "$1" would otherwise be expanded as a
    /// capture-group reference and land on disk as something the user never typed.
    /// </para>
    /// </summary>
    public static string SetFrontmatter(string text, string key, string value)
    {
        var line = Line(key, value);
        var rx = new Regex($@"(?m)^{Regex.Escape(key)}:.*$");
        if (rx.IsMatch(text)) return rx.Replace(text, _ => line, 1);
        var idx = text.IndexOf("\n---", text.IndexOf("---") + 3, StringComparison.Ordinal);
        return idx < 0 ? text : text.Insert(idx, "\n" + line);
    }

    /// <summary>
    /// Insert a frontmatter key immediately AFTER another one, so a value the server
    /// adds lands where a person would have typed it. Falls back to
    /// <see cref="SetFrontmatter"/> when the key already exists or the anchor does not
    /// — without this, an inserted <c>reporter:</c> would land just before the closing
    /// <c>---</c> and the same field would live in two different places depending on
    /// who added it.
    /// </summary>
    public static string SetFrontmatterAfter(string text, string key, string value, string afterKey)
    {
        var rx = new Regex($@"(?m)^{Regex.Escape(key)}:.*$");
        if (rx.IsMatch(text)) return SetFrontmatter(text, key, value);
        var anchor = new Regex($@"(?m)^{Regex.Escape(afterKey)}:.*$").Match(text);
        return anchor.Success
            ? text.Insert(anchor.Index + anchor.Length, "\n" + Line(key, value))
            : SetFrontmatter(text, key, value);
    }

    /// <summary>
    /// One frontmatter line. An empty value writes a bare "key:" rather than
    /// "key: " — these files are committed and read by people, and a trailing
    /// space is the kind of thing that shows up as a diff nobody authored.
    /// </summary>
    public static string Line(string key, string value) =>
        value.Length == 0 ? $"{key}:" : $"{key}: {value}";

    /// <summary>
    /// Split a record into its frontmatter block and the body after it.
    /// Returns false for anything that is not a frontmatter document — a file
    /// we cannot parse is skipped, never guessed at.
    /// </summary>
    public static bool Split(string text, out string front, out string body)
    {
        front = body = "";
        if (!text.StartsWith("---")) return false;
        var end = text.IndexOf("\n---", 3, StringComparison.Ordinal);
        if (end < 0) return false;
        front = text.Substring(3, end - 3);
        body = text[(end + 4)..].TrimStart('\n');
        return true;
    }

    /// <summary>Frontmatter lines to a lower-cased key → unquoted value map.</summary>
    public static Dictionary<string, string> Fields(string front)
    {
        var map = new Dictionary<string, string>();
        foreach (var raw in front.Split('\n'))
        {
            var line = raw.Trim();
            var ci = line.IndexOf(':');
            if (ci <= 0) continue;
            map[line[..ci].Trim().ToLowerInvariant()] = line[(ci + 1)..].Trim().Trim('"');
        }
        return map;
    }

    /// <summary>A bracketed, comma-separated frontmatter list ("[a, b]") to its items.</summary>
    public static List<string> List(string? val)
    {
        var s = (val ?? "").Trim().Trim('[', ']');
        return s.Length == 0
            ? new()
            : s.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
    }

    /// <summary>Render items back into the bracketed frontmatter form.</summary>
    public static string ListValue(IEnumerable<string> items) => "[" + string.Join(", ", items) + "]";

    /// <summary>
    /// Everything before <c>## Comments</c>. That is deliberately "the content",
    /// not "the Description section": a record is free-form markdown and may carry
    /// its own headings (Steps to reproduce, Notes, …), which belong to the body
    /// rather than being silently dropped by a stricter parse.
    /// </summary>
    public static string ContentBlock(string body)
    {
        var i = body.IndexOf("## Comments", StringComparison.Ordinal);
        return i >= 0 ? body[..i] : body;
    }

    /// <summary>Parse the <c>## Comments</c> thread, oldest first (file order).</summary>
    public static List<Comment> Comments(string body)
    {
        var list = new List<Comment>();
        var i = body.IndexOf("## Comments", StringComparison.Ordinal);
        if (i < 0) return list;
        var block = body[(i + "## Comments".Length)..];
        var matches = CommentHdr.Matches(block);
        for (int n = 0; n < matches.Count; n++)
        {
            var m = matches[n];
            var start = m.Index + m.Length;
            var stop = n + 1 < matches.Count ? matches[n + 1].Index : block.Length;
            list.Add(new Comment(m.Groups["date"].Value, m.Groups["author"].Value.Trim(), block[start..stop].Trim()));
        }
        return list;
    }

    /// <summary>Drop a leading <c>## Heading</c> from a block, if it is there.</summary>
    public static string StripHeading(string s, string heading)
    {
        var i = s.IndexOf(heading, StringComparison.Ordinal);
        return i < 0 ? s : s[(i + heading.Length)..];
    }

    static readonly Regex NextH2 = new(@"(?m)^##\s", RegexOptions.None);

    /// <summary>Index of the next <c>"## "</c> heading at or after <paramref name="from"/>,
    /// or -1. <c>"###"</c> does not count: the third '#' is not the whitespace the pattern
    /// needs, which is what lets a comment thread sit inside a section.</summary>
    public static int NextH2Index(string text, int from)
    {
        var m = NextH2.Match(text, from);
        return m.Success ? m.Index : -1;
    }

    /// <summary>
    /// Cut one <c>## Heading</c> section OUT of a content block: the block comes back
    /// without it, the section's body in <paramref name="section"/>.
    /// <para>Carved BEFORE the looser parses run, because both stores read their
    /// last section as "everything to the end of the content" — Bug.Description via
    /// StripHeading, BacklogItem.Acceptance by index. A section left in place is
    /// swallowed by whichever runs, and then written back over the top of itself by
    /// the next SetSection. The result is a PARSE input only; it is never written
    /// back to disk.</para>
    /// </summary>
    public static string CarveSection(string content, string heading, out string section)
    {
        section = "";
        var at = content.IndexOf(heading, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return content;
        var start = at + heading.Length;
        var next = NextH2Index(content, start);
        var stop = next < 0 ? content.Length : next;
        section = content[start..stop].Trim();
        return content[..at] + content[stop..];
    }

    /// <summary>
    /// Replace the body of one <c>## Heading</c> section, leaving every other
    /// section — and the frontmatter — untouched.
    /// <para>
    /// An absent section is INSERTED rather than dropped: above <c>## History</c>
    /// when the record has one, above <c>## Comments</c> otherwise. Both anchors
    /// keep the thread at the bottom of the file where both the parser and a human
    /// reader expect it, and History has to stay directly above the thread because
    /// both stores parse only the block before it. A record written by hand without
    /// an "Acceptance criteria" section is the normal case for anything not yet
    /// refined, so this path is the common one, not the exception.
    /// </para>
    /// </summary>
    public static string SetSection(string text, string heading, string value)
    {
        var body = value.Trim();
        var block = $"{heading}\n\n{(body.Length == 0 ? "_(empty)_" : body)}\n";

        var at = text.IndexOf(heading, StringComparison.OrdinalIgnoreCase);
        if (at >= 0)
        {
            var after = at + heading.Length;
            var next = NextH2Index(text, after);
            var stop = next < 0 ? text.Length : next;
            return text[..at] + block + "\n" + text[stop..];
        }

        // A section the server creates has to land where a hand edit would have put
        // it, or every record touched both ways carries a diff nobody authored.
        var stopAt = text.IndexOf(RecordHistory.Heading, StringComparison.OrdinalIgnoreCase);
        if (stopAt < 0) stopAt = text.IndexOf("## Comments", StringComparison.Ordinal);
        return stopAt >= 0
            ? text[..stopAt] + block + "\n" + text[stopAt..]
            : text.TrimEnd() + "\n\n" + block;
    }

    static readonly Regex ChecklistLine = new(@"^(?<indent>\s*)(?<bullet>[-*])\s+\[(?<box>[ xX])\]\s?(?<text>.*)$");

    /// <summary>
    /// Edit ONE checklist line inside a <c>## Heading</c> section, addressed by
    /// its position among that section's checklist items.
    /// <para>
    /// Line surgery rather than "rebuild the section from a list of items"
    /// because the section is hand-authored markdown: it may carry a sentence
    /// of context above the list, a nested sub-bullet, a blank line the author
    /// wanted. Regenerating it from parsed items would silently delete all of
    /// that the first time anyone ticked a box.
    /// </para>
    /// </summary>
    /// <param name="op">toggle | edit | remove | add</param>
    /// <param name="index">which checklist item (ignored by <c>add</c>)</param>
    /// <param name="value">the new text for <c>edit</c>/<c>add</c>; "1"/"0" for <c>toggle</c></param>
    /// <returns>the whole document, or null when the op cannot apply.</returns>
    public static string? EditChecklist(string text, string heading, string op, int index, string value)
    {
        var at = text.IndexOf(heading, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return null;
        var bodyStart = at + heading.Length;
        var next = NextH2Index(text, bodyStart);
        var bodyEnd = next < 0 ? text.Length : next;

        var body = text[bodyStart..bodyEnd];
        var lines = body.Split('\n').ToList();

        // Positions of the checklist items, so `index` means the Nth checkbox
        // rather than the Nth line — which is what the UI counted.
        var items = new List<int>();
        for (int i = 0; i < lines.Count; i++)
            if (ChecklistLine.IsMatch(lines[i])) items.Add(i);

        if (op == "add")
        {
            var line = $"- [ ] {value.Trim()}";
            if (items.Count > 0)
            {
                lines.Insert(items[^1] + 1, line);
            }
            else
            {
                // A section holding only the "_(not refined yet)_" placeholder
                // is empty in every sense that matters — replace it rather than
                // leaving it above the first real criterion.
                var kept = lines.Where(l => !Regex.IsMatch(l.Trim(), @"^_\(.*\)_$")).ToList();
                while (kept.Count > 0 && kept[^1].Trim().Length == 0) kept.RemoveAt(kept.Count - 1);
                while (kept.Count > 0 && kept[0].Trim().Length == 0) kept.RemoveAt(0);
                // Blank line after the heading and before whatever follows the
                // section: this is committed markdown people read in a diff, and
                // a heading welded to its first bullet reads as a mistake even
                // though it parses.
                lines = new List<string> { "" };
                if (kept.Count > 0) { lines.AddRange(kept); lines.Add(""); }
                lines.Add("");
                lines.Add(line);
                lines.Add("");
                lines.Add("");
            }
        }
        else
        {
            if (index < 0 || index >= items.Count) return null;
            var li = items[index];
            var m = ChecklistLine.Match(lines[li]);
            if (op == "remove")
            {
                lines.RemoveAt(li);
            }
            else if (op == "toggle")
            {
                var box = value is "1" or "true" ? "x" : " ";
                lines[li] = $"{m.Groups["indent"].Value}{m.Groups["bullet"].Value} [{box}] {m.Groups["text"].Value}";
            }
            else if (op == "edit")
            {
                lines[li] = $"{m.Groups["indent"].Value}{m.Groups["bullet"].Value} [{m.Groups["box"].Value}] {value.Trim()}";
            }
            else return null;
        }

        return text[..bodyStart] + string.Join('\n', lines) + text[bodyEnd..];
    }

    /// <summary>
    /// Append a <c>### date · author</c> comment and bump <c>updated</c>. Creates the
    /// <c>## Comments</c> section when the record has none yet.
    /// </summary>
    public static string AppendComment(string text, string author, string body)
    {
        var next = text.TrimEnd() + "\n\n";
        if (!next.Contains("## Comments")) next += "## Comments\n\n";
        next += $"### {Today()} · {author}\n\n{body.Trim()}\n";
        return SetFrontmatter(next, "updated", Today());
    }

    /// <summary>
    /// A title safe to write into a double-quoted frontmatter value. Inner quotes
    /// become apostrophes rather than being escaped: the frontmatter parser here is
    /// a line reader, not a YAML engine, and an escaped quote would survive the
    /// round-trip as a literal backslash.
    /// </summary>
    public static string Quote(string title) => title.Replace("\"", "'");
}
