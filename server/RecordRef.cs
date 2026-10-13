using System.Text.RegularExpressions;

/// <summary>
/// One record's identity, across both stores: which store it lives in, and its
/// numeric id.
/// <para>
/// Identity is (Store, Id) and never the printed prefix. Backlog ids are a
/// SINGLE sequence shared by all four prefixes, so <c>STORY-7</c> and
/// <c>EPIC-7</c> name the same record: the prefix is display sugar plus a store
/// discriminator, and it goes stale the moment somebody retypes an item. Every
/// write path re-derives the prefix from the record it resolved, never from what
/// was typed.
/// </para>
/// </summary>
readonly record struct RecordRef(string Store, int Id)
{
    public bool Ok => Id > 0 && (Store == "bugs" || Store == "backlog");
}

/// <summary>
/// The one reference grammar: a link target, a duplicate-of target, anything a
/// person types to name another record. A bare number is STORE-RELATIVE — it
/// means "in the same store as the file holding it" — which is why every entry
/// point takes the origin store rather than assuming bugs.
/// </summary>
static class Refs
{
    /// <summary>
    /// <c>52</c>, <c>#52</c> (tolerated on read, never written) or
    /// <c>PREFIX-NNNN</c>. The <c>0*</c> is load-bearing: records on disk carry
    /// both <c>STORY-7</c> and <c>STORY-0007</c>, and they are the same item.
    /// Keep this pattern free of double-quote characters — the drift test lifts
    /// it out of this source file and runs it as a JS RegExp.
    /// </summary>
    public static readonly Regex Token =
        new(@"^\s*(?:#?(?<n>\d+)|(?<p>[A-Za-z]+)-0*(?<pn>\d+))\s*$",
            RegexOptions.None);

    /// <summary>Resolve a token against the store the file holding it lives in.
    /// An unparseable token comes back as <c>default</c> (<c>Ok == false</c>),
    /// exactly as an unknown link verb is skipped today.</summary>
    public static RecordRef Parse(string? token, string selfStore = "bugs")
    {
        var m = Token.Match(token ?? "");
        if (!m.Success) return default;
        // TryParse, not Parse: `\d+` has no upper bound, so a target of
        // "2147483648" is a well-formed token that overflows an int. Parse would
        // throw out of the endpoint as an unhandled 500 with an empty body, while
        // every other malformed target on the same route is a clean 400 — so an
        // out-of-range number joins them rather than being a special case.
        if (m.Groups["n"].Success)
        {
            return int.TryParse(m.Groups["n"].Value, out var n) && n > 0
                ? new RecordRef(selfStore, n) : default;
        }
        if (!int.TryParse(m.Groups["pn"].Value, out var id) || id <= 0) return default;
        // Any prefix the project has used — its current ones, the ones a save
        // replaced and the defaults (Numbering.cs) — so a reference written before
        // a rename still resolves.
        var hit = Numbering.Current.Resolve(m.Groups["p"].Value);
        return hit is { } h ? new RecordRef(h.Store, id) : default;   // an unknown prefix is never guessed at
    }

    /// <summary>
    /// The canonical form to STORE: bare when the target is in the same store as
    /// the file, prefixed and zero-padded when it crosses. <paramref name="type"/>
    /// is the type of the RESOLVED record — deriving it from what was typed is how
    /// a stale prefix survives a retype.
    /// </summary>
    public static string Format(RecordRef r, string selfStore = "bugs", string type = "task") =>
        r.Store == selfStore ? r.Id.ToString() : Numbering.Current.Format(r.Store, type, r.Id);

    /// <summary>
    /// The form to write into a comment SENTENCE (and into an API <c>ref</c>
    /// field): always prefixed, always padded. Deliberately unlike the UI's
    /// <c>#42</c> — a bare fragment inside a sentence that crosses stores reads as
    /// a heading anchor rather than as a bug.
    /// </summary>
    public static string Display(RecordRef r, string type = "task") =>
        Numbering.Current.Format(r.Store, type, r.Id);
}
