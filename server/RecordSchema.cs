using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

/// <summary>
/// A project's record schema — its own fields, the built-in fields it hides and
/// its own statuses, per record type. Stored under <c>schema</c> in the committed
/// <c>.bugdesk/project.json</c>, so everyone on the store sees the same one.
///
/// <code>
/// "schema": {
///   "bugs":    { "bug": { "fields": [...], "hidden": [...], "statuses": [...] }, "regression": {...}, "task": {...} },
///   "backlog": { "project": {...}, "epic": {...}, "story": {...}, "task": {...} }
/// }
/// field:  { "name": "not_before", "label": "Not before", "type": "date", "required": false, "values": [] }
/// status: { "name": "blocked", "label": "Blocked", "category": "waiting", "after": "investigation" }
/// </code>
///
/// <para>
/// Keyed by STORE, then type, because the two stores share the word <c>task</c>:
/// a backlog task and a Chore bug are different records with different fields.
/// A tracker's tickets are backlog records in the tracker's own store, so they
/// are configured in that store's <c>project.json</c> under <c>backlog</c>.
/// </para>
///
/// <para>
/// A record holds a custom field's value as one more frontmatter line
/// (<c>not_before: 2026-11-01</c>), so an agent editing the file by hand sets it
/// the same way it sets <c>assignee</c>. Nothing here ever rewrites a record:
/// removing a field or hiding a built-in changes what is SHOWN, and the values
/// stay in the files.
/// </para>
///
/// <para>
/// Reading never throws. A malformed schema is no schema plus a warning the UI
/// shows, because a typo in a committed file must not take every page down.
/// </para>
/// </summary>
static class RecordSchema
{
    public static readonly string[] FieldTypes = { "text", "number", "date", "bool", "choice" };
    public static readonly string[] Categories = { "active", "waiting", "finished" };

    public static readonly Dictionary<string, string[]> TypesOf = new()
    {
        ["bugs"] = new[] { "bug", "regression", "task" },
        ["backlog"] = new[] { "project", "epic", "story", "task" },
    };

    /// <summary>Every frontmatter key a store's records use for themselves.
    /// Anything else in a record's frontmatter is a custom field.</summary>
    public static readonly Dictionary<string, HashSet<string>> BuiltinKeys = new()
    {
        ["bugs"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "id", "title", "status", "severity", "type", "subsystem", "assignee", "reporter",
            "labels", "links", "created", "updated",
        },
        ["backlog"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "id", "type", "title", "status", "parent", "phase", "assignee", "reporter", "due",
            "points", "subsystem", "labels", "links", "created", "updated",
        },
    };

    /// <summary>Names a custom field may never take, in either store: every
    /// built-in key, and the words the API already uses for a record's parts.</summary>
    static readonly HashSet<string> Reserved = new(
        BuiltinKeys["bugs"].Concat(BuiltinKeys["backlog"]).Concat(new[]
        {
            "description", "acceptance", "comments", "history", "fields", "stage", "pri", "ladder",
            "children", "criteria", "effectivephase", "effectivedue", "typeorder", "comment", "actor",
        }), StringComparer.OrdinalIgnoreCase);

    /// <summary>The built-in fields a project may hide. Everything else —
    /// id, title, status, type, created, updated, and the assignee, reporter and
    /// parent the claim, handback and tree depend on — is always shown.</summary>
    public static readonly Dictionary<string, string[]> Hideable = new()
    {
        ["bugs"] = new[] { "severity", "subsystem", "labels", "links" },
        ["backlog"] = new[] { "phase", "due", "points", "subsystem", "labels", "links" },
    };

    /// <summary>The built-in statuses and what each counts as. These cannot be
    /// removed: the /bugs and /backlog skills' claim and handback name them.</summary>
    public static readonly Dictionary<string, (string Name, string Category)[]> BuiltinStatuses = new()
    {
        ["bugs"] = new[] { ("open", "active"), ("investigation", "active"), ("testing", "active"), ("closed", "finished") },
        ["backlog"] = new[]
        {
            ("draft", "active"), ("refined", "active"), ("in-progress", "active"), ("review", "active"),
            ("done", "finished"), ("dropped", "finished"),
        },
    };

    static readonly Regex NameRx = new("^[a-z][a-z0-9_-]{0,39}$");

    public record Field(string Name, string Label, string Type, bool Required, List<string> Values);
    public record Status(string Name, string Label, string Category, string After);
    public record TypeSpec(List<Field> Fields, List<string> Hidden, List<Status> Statuses)
    {
        public static TypeSpec Empty => new(new(), new(), new());
    }

    /// <summary>A parsed schema: <c>Types[store][type]</c>, every store and type
    /// present (empty when unconfigured), plus what was wrong with the file.</summary>
    public sealed class Schema
    {
        public Dictionary<string, Dictionary<string, TypeSpec>> Types { get; } = new();
        public List<string> Warnings { get; } = new();

        public TypeSpec For(string store, string type) =>
            Types.TryGetValue(store, out var t) && t.TryGetValue(type ?? "", out var s) ? s : TypeSpec.Empty;

        public Field? FieldOf(string store, string type, string name) =>
            For(store, type).Fields.FirstOrDefault(f => f.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

        /// <summary>Is <paramref name="status"/> one of this type's custom statuses?</summary>
        public bool HasStatus(string store, string type, string status) =>
            For(store, type).Statuses.Any(s => s.Name == status);

        /// <summary>What a status counts as — built-in or custom. Null when it is neither.</summary>
        public string? CategoryOf(string store, string type, string status)
        {
            foreach (var (n, c) in BuiltinStatuses[store]) if (n == status) return c;
            return For(store, type).Statuses.FirstOrDefault(s => s.Name == status)?.Category;
        }

        public JsonObject ToJson()
        {
            var root = new JsonObject();
            foreach (var (store, types) in Types)
            {
                var so = new JsonObject();
                foreach (var (type, spec) in types)
                {
                    if (spec.Fields.Count == 0 && spec.Hidden.Count == 0 && spec.Statuses.Count == 0) continue;
                    so[type] = new JsonObject
                    {
                        ["fields"] = new JsonArray(spec.Fields.Select(f => (JsonNode)new JsonObject
                        {
                            ["name"] = f.Name, ["label"] = f.Label, ["type"] = f.Type, ["required"] = f.Required,
                            ["values"] = new JsonArray(f.Values.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()),
                        }).ToArray()),
                        ["hidden"] = new JsonArray(spec.Hidden.Select(h => (JsonNode)JsonValue.Create(h)!).ToArray()),
                        ["statuses"] = new JsonArray(spec.Statuses.Select(s => (JsonNode)new JsonObject
                        {
                            ["name"] = s.Name, ["label"] = s.Label, ["category"] = s.Category, ["after"] = s.After,
                        }).ToArray()),
                    };
                }
                if (so.Count > 0) root[store] = so;
            }
            return root;
        }
    }

    /// <summary>
    /// Parse a <c>schema</c> node. <paramref name="strict"/> collects every problem
    /// as an error (what a save is checked with); otherwise the bad entries are
    /// skipped and reported as warnings (what a read does).
    /// </summary>
    public static Schema Parse(JsonNode? node)
    {
        var schema = new Schema();
        foreach (var (store, types) in TypesOf)
        {
            schema.Types[store] = new();
            foreach (var t in types) schema.Types[store][t] = TypeSpec.Empty;
        }
        if (node is null) return schema;
        if (node is not JsonObject root)
        {
            schema.Warnings.Add("project.json: `schema` is not an object; no custom fields or statuses are in effect.");
            return schema;
        }

        foreach (var (store, storeNode) in root)
        {
            if (!TypesOf.ContainsKey(store))
            {
                schema.Warnings.Add($"schema: unknown store '{store}' (expected bugs or backlog); ignored.");
                continue;
            }
            if (storeNode is not JsonObject typesObj)
            {
                schema.Warnings.Add($"schema.{store} is not an object; ignored.");
                continue;
            }
            foreach (var (type, specNode) in typesObj)
            {
                var where = $"schema.{store}.{type}";
                if (!TypesOf[store].Contains(type))
                {
                    schema.Warnings.Add($"{where}: unknown {store} type '{type}'; ignored.");
                    continue;
                }
                if (specNode is not JsonObject spec)
                {
                    schema.Warnings.Add($"{where} is not an object; ignored.");
                    continue;
                }
                schema.Types[store][type] = ParseType(store, type, spec, where, schema.Warnings);
            }
        }
        return schema;
    }

    static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "";

    static TypeSpec ParseType(string store, string type, JsonObject spec, string where, List<string> problems)
    {
        var fields = new List<Field>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (spec["fields"] is JsonArray fa)
        {
            foreach (var fn in fa)
            {
                var name = Str(fn?["name"]).ToLowerInvariant();
                if (!NameRx.IsMatch(name))
                {
                    problems.Add($"{where}: field name '{name}' must start with a letter and use only a-z, 0-9, - and _.");
                    continue;
                }
                if (Reserved.Contains(name))
                {
                    problems.Add($"{where}: '{name}' is a built-in field; a custom field cannot take its name.");
                    continue;
                }
                if (!seen.Add(name))
                {
                    problems.Add($"{where}: there is already a field called '{name}' on this type.");
                    continue;
                }
                var ftype = Str(fn?["type"]).ToLowerInvariant();
                if (ftype.Length == 0) ftype = "text";
                if (!FieldTypes.Contains(ftype))
                {
                    problems.Add($"{where}.{name}: type '{ftype}' is not one of {string.Join(", ", FieldTypes)}.");
                    continue;
                }
                var values = fn?["values"] is JsonArray va
                    ? va.Select(Str).Where(s => s.Length > 0).Distinct().ToList()
                    : new List<string>();
                if (ftype == "choice" && values.Count == 0)
                {
                    problems.Add($"{where}.{name}: a choice field needs at least one value.");
                    continue;
                }
                if (values.Any(v => v.Contains('\n') || v.Contains(',')))
                {
                    problems.Add($"{where}.{name}: a choice value cannot contain a comma or a line break.");
                    continue;
                }
                var label = Str(fn?["label"]);
                var required = fn?["required"] is JsonValue rv && rv.TryGetValue<bool>(out var r) && r;
                fields.Add(new Field(name, label.Length > 0 ? label : name, ftype, required,
                    ftype == "choice" ? values : new()));
            }
        }

        var hidden = new List<string>();
        if (spec["hidden"] is JsonArray ha)
        {
            foreach (var hn in ha)
            {
                var h = Str(hn).ToLowerInvariant();
                if (Hideable[store].Contains(h)) { if (!hidden.Contains(h)) hidden.Add(h); }
                else problems.Add($"{where}: '{h}' cannot be hidden (hideable: {string.Join(", ", Hideable[store])}).");
            }
        }

        var statuses = new List<Status>();
        var builtin = BuiltinStatuses[store].Select(s => s.Name).ToHashSet();
        var statusSeen = new HashSet<string>();
        if (spec["statuses"] is JsonArray sa)
        {
            foreach (var sn in sa)
            {
                var name = Str(sn?["name"]).ToLowerInvariant();
                if (!NameRx.IsMatch(name))
                {
                    problems.Add($"{where}: status name '{name}' must start with a letter and use only a-z, 0-9, - and _.");
                    continue;
                }
                if (builtin.Contains(name))
                {
                    problems.Add($"{where}: '{name}' is a built-in status; a custom status cannot take its name.");
                    continue;
                }
                if (!statusSeen.Add(name))
                {
                    problems.Add($"{where}: there is already a status called '{name}' on this type.");
                    continue;
                }
                var cat = Str(sn?["category"]).ToLowerInvariant();
                if (!Categories.Contains(cat))
                {
                    problems.Add($"{where}.{name}: category must be one of {string.Join(", ", Categories)}.");
                    continue;
                }
                var after = Str(sn?["after"]).ToLowerInvariant();
                var label = Str(sn?["label"]);
                statuses.Add(new Status(name, label.Length > 0 ? label : name, cat, after));
            }
        }
        // `after` may name a built-in or a custom status of the same type; a stale
        // one just appends, rather than failing the whole type.
        var known = builtin.Concat(statuses.Select(s => s.Name)).ToHashSet();
        statuses = statuses.Select(s => s.After.Length == 0 || known.Contains(s.After) ? s : s with { After = "" }).ToList();
        return new TypeSpec(fields, hidden, statuses);
    }

    /// <summary>
    /// Check one value against its field, and normalise it to what is written.
    /// Returns an error naming the field, or null.
    /// </summary>
    public static string? Check(Field f, string raw, out string value)
    {
        value = (raw ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (value.Length == 0) return null;
        switch (f.Type)
        {
            case "number":
                if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out _))
                    return $"{f.Label} must be a number (got '{value}').";
                break;
            case "date":
                var d = BacklogItem.NormalizeDate(value);
                if (d.Length == 0) return $"{f.Label} must be a date, YYYY-MM-DD (got '{value}').";
                value = d;
                break;
            case "bool":
                var b = value.ToLowerInvariant();
                if (b is "true" or "yes" or "1") value = "true";
                else if (b is "false" or "no" or "0") value = "false";
                else return $"{f.Label} must be yes or no (got '{value}').";
                break;
            case "choice":
                var given = value;
                var match = f.Values.FirstOrDefault(v => v.Equals(given, StringComparison.OrdinalIgnoreCase));
                if (match is null) return $"{f.Label} must be one of {string.Join(", ", f.Values)} (got '{value}').";
                value = match;
                break;
        }
        return null;
    }

    /// <summary>The frontmatter text for a value: text is quoted (it may hold a
    /// colon or a leading bracket), everything else is written bare.</summary>
    public static string Render(Field f, string value) =>
        f.Type == "text" && value.Length > 0 ? $"\"{Md.Quote(value)}\"" : value;

    /// <summary>A record's custom frontmatter: every key its store does not use
    /// for itself, in file order. Kept whether or not the schema still names it.</summary>
    public static Dictionary<string, string> Extras(string store, Dictionary<string, string> fields) =>
        fields.Where(kv => !BuiltinKeys[store].Contains(kv.Key))
              .ToDictionary(kv => kv.Key, kv => kv.Value);
}
