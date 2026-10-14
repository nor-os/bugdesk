using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

/// <summary>
/// How a store names and numbers its records — <c>numbering</c> in the committed
/// <c>.bugdesk/project.json</c>, edited from Settings › Record types.
///
/// <code>
/// "numbering": {
///   "bugs":    { "prefix": "BUG", "pad": 4, "start": 1, "step": 1, "previous": [] },
///   "backlog": { "prefix": { "project": "PROJ", "epic": "EPIC", "story": "STORY", "task": "TASK" },
///                "pad": 4, "start": 1, "step": 1, "previous": { "story": ["US"] } }
/// }
/// </code>
///
/// <para>
/// With nothing set, every value is today's: <c>BUG-0042</c>, <c>STORY-0007</c>,
/// padded to four, counting up by one from one.
/// </para>
///
/// <para>
/// A CHANGED PREFIX NEVER RENAMES A FILE. Records keep the names they were
/// written under; only new ones take the new prefix. So every prefix a store
/// has ever used stays readable: the defaults always, and the ones a save
/// replaced, which the save records under <c>previous</c>. A typed reference, a
/// link token and a file name in any of them resolve to the same record — the
/// number is the identity, the prefix only says which store and type.
/// </para>
///
/// <para>
/// An id is still never reused: the next is above every id the store has ever
/// seen (RecordIds), stepped by <c>step</c>, and never below <c>start</c>.
/// </para>
/// </summary>
sealed class Numbering
{
    public static readonly Dictionary<string, string> DefaultBacklog = new()
    {
        ["project"] = "PROJ", ["epic"] = "EPIC", ["story"] = "STORY", ["task"] = "TASK",
    };

    static readonly Regex PrefixRx = new("^[A-Za-z]{1,12}$");

    public string BugPrefix { get; private init; } = "BUG";
    public Dictionary<string, string> BacklogPrefix { get; private init; } = new(DefaultBacklog);
    public int BugPad { get; private init; } = 4;
    public int BacklogPad { get; private init; } = 4;
    public int BugStart { get; private init; } = 1;
    public int BacklogStart { get; private init; } = 1;
    public int BugStep { get; private init; } = 1;
    public int BacklogStep { get; private init; } = 1;
    public List<string> BugPrevious { get; private init; } = new();
    public Dictionary<string, List<string>> BacklogPrevious { get; private init; } = new();

    public static readonly Numbering Default = new();

    /// <summary>The record's reference: prefix, dash, the id padded as configured.</summary>
    public string Format(string store, string type, int id) => store == "bugs"
        ? $"{BugPrefix}-{Pad(id, BugPad)}"
        : $"{BacklogPrefix.GetValueOrDefault(type, BacklogPrefix.GetValueOrDefault("task", "TASK"))}-{Pad(id, BacklogPad)}";

    static string Pad(int id, int pad) => pad > 0 ? id.ToString().PadLeft(pad, '0') : id.ToString();

    /// <summary>The file a NEW record of this store and type is written to.</summary>
    public string FileName(string store, string type, int id) => Format(store, type, id) + ".md";

    /// <summary>Every prefix a bug file or reference may carry: current, previous, default.</summary>
    public IEnumerable<string> BugPrefixes() =>
        new[] { BugPrefix }.Concat(BugPrevious).Append("BUG").Distinct(StringComparer.OrdinalIgnoreCase);

    /// <summary>Every prefix of the backlog, each with the type it names.</summary>
    public IEnumerable<(string Prefix, string Type)> BacklogPrefixes()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (t, p) in BacklogPrefix) if (seen.Add(p)) yield return (p, t);
        foreach (var (t, ps) in BacklogPrevious) foreach (var p in ps) if (seen.Add(p)) yield return (p, t);
        foreach (var (t, p) in DefaultBacklog) if (seen.Add(p)) yield return (p, t);
    }

    /// <summary>Which store and type a prefix names, or null.</summary>
    public (string Store, string Type)? Resolve(string prefix)
    {
        if (BugPrefixes().Any(p => p.Equals(prefix, StringComparison.OrdinalIgnoreCase))) return ("bugs", "");
        foreach (var (p, t) in BacklogPrefixes())
            if (p.Equals(prefix, StringComparison.OrdinalIgnoreCase)) return ("backlog", t);
        return null;
    }

    /// <summary>The next id, given the highest the store has ever seen.</summary>
    public int Next(string store, int maxSeen)
    {
        var (start, step) = store == "bugs" ? (BugStart, BugStep) : (BacklogStart, BacklogStep);
        return Math.Max(start, maxSeen + Math.Max(1, step));
    }

    /// <summary>
    /// The file holding record <paramref name="id"/> in <paramref name="dir"/>, under
    /// any prefix the store has used and any padding; null when there is none.
    /// </summary>
    public string? Find(string dir, string store, int id)
    {
        if (!Directory.Exists(dir)) return null;
        var prefixes = store == "bugs" ? BugPrefixes() : BacklogPrefixes().Select(p => p.Prefix);
        var rx = new Regex(@"^(?:" + string.Join("|", prefixes.Select(Regex.Escape)) + @")-0*" + id + @"\.md$",
            RegexOptions.IgnoreCase);
        return Directory.EnumerateFiles(dir, "*.md").FirstOrDefault(f => rx.IsMatch(Path.GetFileName(f)));
    }

    static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "";
    static int Int(JsonNode? n, int fallback) =>
        n is JsonValue v && (v.TryGetValue<int>(out var i) || (v.TryGetValue<string>(out var s) && int.TryParse(s, out i))) ? i : fallback;
    static List<string> Strs(JsonNode? n) => n is JsonArray a ? a.Select(Str).Where(s => s.Length > 0).ToList() : new();

    /// <summary>
    /// Read a <c>numbering</c> node. Problems are collected rather than thrown; a
    /// read keeps every valid value and falls back to the default for the rest,
    /// a save is refused on any.
    /// </summary>
    public static Numbering Parse(JsonNode? node, List<string>? problems = null)
    {
        problems ??= new();
        if (node is not JsonObject root) return Default;
        var bugs = root["bugs"] as JsonObject;
        var backlog = root["backlog"] as JsonObject;

        string CheckPrefix(string p, string where, string fallback)
        {
            if (p.Length == 0) return fallback;
            if (!PrefixRx.IsMatch(p)) { problems.Add($"{where}: '{p}' is not a usable prefix — letters only, at most 12."); return fallback; }
            return p.ToUpperInvariant();
        }
        int CheckPad(JsonNode? n, string where)
        {
            var v = Int(n, 4);
            if (v is < 0 or > 8) { problems.Add($"{where}: padding must be 0 (none) to 8."); return 4; }
            return v;
        }
        int CheckPositive(JsonNode? n, string where, int min)
        {
            var v = Int(n, 1);
            if (v < min) { problems.Add($"{where} must be at least {min}."); return 1; }
            return v;
        }

        var bugPrefix = CheckPrefix(Str(bugs?["prefix"]), "bugs.prefix", "BUG");
        var backlogPrefix = new Dictionary<string, string>(DefaultBacklog);
        if (backlog?["prefix"] is JsonObject bp)
            foreach (var (t, v) in bp)
            {
                if (!DefaultBacklog.ContainsKey(t)) { problems.Add($"backlog.prefix: '{t}' is not a backlog type."); continue; }
                backlogPrefix[t] = CheckPrefix(Str(v), $"backlog.prefix.{t}", DefaultBacklog[t]);
            }
        var previous = new Dictionary<string, List<string>>();
        if (backlog?["previous"] is JsonObject prev)
            foreach (var (t, v) in prev)
                if (DefaultBacklog.ContainsKey(t)) previous[t] = Strs(v).Select(p => p.ToUpperInvariant()).ToList();

        var n = new Numbering
        {
            BugPrefix = bugPrefix,
            BacklogPrefix = backlogPrefix,
            BugPad = CheckPad(bugs?["pad"], "bugs.pad"),
            BacklogPad = CheckPad(backlog?["pad"], "backlog.pad"),
            BugStart = CheckPositive(bugs?["start"], "bugs.start", 1),
            BacklogStart = CheckPositive(backlog?["start"], "backlog.start", 1),
            BugStep = CheckPositive(bugs?["step"], "bugs.step", 1),
            BacklogStep = CheckPositive(backlog?["step"], "backlog.step", 1),
            BugPrevious = Strs(bugs?["previous"]).Select(p => p.ToUpperInvariant()).ToList(),
            BacklogPrevious = previous,
        };

        // One prefix, one meaning: a prefix two types (or both stores) share would
        // make `X-0042` mean two records.
        var owners = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { [n.BugPrefix] = "bugs" };
        foreach (var (t, p) in n.BacklogPrefix)
        {
            if (owners.TryGetValue(p, out var other)) problems.Add($"the prefix '{p}' is used for both {other} and {t}.");
            else owners[p] = t;
        }
        return n;
    }

    public JsonObject ToJson() => new()
    {
        ["bugs"] = new JsonObject
        {
            ["prefix"] = BugPrefix, ["pad"] = BugPad, ["start"] = BugStart, ["step"] = BugStep,
            ["previous"] = new JsonArray(BugPrevious.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()),
        },
        ["backlog"] = new JsonObject
        {
            ["prefix"] = new JsonObject(BacklogPrefix.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)JsonValue.Create(kv.Value)))),
            ["pad"] = BacklogPad, ["start"] = BacklogStart, ["step"] = BacklogStep,
            ["previous"] = new JsonObject(BacklogPrevious.Select(kv => KeyValuePair.Create(kv.Key,
                (JsonNode?)new JsonArray(kv.Value.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray())))),
        },
    };

    /// <summary>
    /// The numbering a save produces from <paramref name="before"/>: every prefix
    /// the save replaces is kept under <c>previous</c>, so the records written
    /// under it stay reachable by reference.
    /// </summary>
    public static Numbering Carry(Numbering before, Numbering next)
    {
        var bugPrev = next.BugPrevious.ToList();
        if (!before.BugPrefix.Equals(next.BugPrefix, StringComparison.OrdinalIgnoreCase)) bugPrev.Add(before.BugPrefix);
        var backPrev = next.BacklogPrevious.ToDictionary(kv => kv.Key, kv => kv.Value.ToList());
        foreach (var (t, p) in before.BacklogPrefix)
        {
            if (next.BacklogPrefix.TryGetValue(t, out var np) && np.Equals(p, StringComparison.OrdinalIgnoreCase)) continue;
            if (!backPrev.ContainsKey(t)) backPrev[t] = new();
            backPrev[t].Add(p);
        }
        // Defaults are always readable, so listing them is noise.
        bugPrev = bugPrev.Where(p => !p.Equals("BUG", StringComparison.OrdinalIgnoreCase) && !p.Equals(next.BugPrefix, StringComparison.OrdinalIgnoreCase))
                         .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var t in backPrev.Keys.ToList())
        {
            backPrev[t] = backPrev[t].Where(p => !DefaultBacklog.Values.Contains(p, StringComparer.OrdinalIgnoreCase)
                                                 && !p.Equals(next.BacklogPrefix[t], StringComparison.OrdinalIgnoreCase))
                                     .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (backPrev[t].Count == 0) backPrev.Remove(t);
        }
        return new Numbering
        {
            BugPrefix = next.BugPrefix, BacklogPrefix = next.BacklogPrefix,
            BugPad = next.BugPad, BacklogPad = next.BacklogPad, BugStart = next.BugStart, BacklogStart = next.BacklogStart,
            BugStep = next.BugStep, BacklogStep = next.BacklogStep, BugPrevious = bugPrev, BacklogPrevious = backPrev,
        };
    }

    /// <summary>The numbering of the store this request is addressed to, or the default.</summary>
    public static Numbering Current => Req.Maybe?.Project.Numbering() ?? Default;
}
