using System.Text.Json.Nodes;

/// <summary>
/// A project's workflow — the moves each status offers and what a move does on
/// the side — under <c>workflow</c> in the committed <c>.bugdesk/project.json</c>.
///
/// <code>
/// "workflow": {
///   "bugs":    { "moves": [ { "from": "testing", "label": "Close", "to": "closed", "message": true, "flow": {...} } ] },
///   "backlog": { "story": { "moves": [...] }, "task": { "moves": [...] } },
///   "actions": { "bugs": { "bug": [ { "id": "blocked", "label": "Blocked", "when": ["open"], "flow": "ask-why" } ] } },
///   "flows":   [ { "id": "ask-why", "label": "Ask why", "store": "bugs", "flow": {...} } ],
///   "massActions": { "bugs": { "bug": [ "assignee", "status", "action:blocked" ] } }
/// }
/// </code>
///
/// <para>
/// A move's or an action's <c>flow</c> names one of the project's FLOWS by id
/// (STORY-0028): flows are managed on their own and shared. A graph stored
/// inline, the way it was before, is still read and checked. A named flow is
/// checked on its own against every type of its store, and again for each row
/// that uses it, against that row's types. A move's flow shows its status
/// change as a step, and one way through it must reach the move's own target.
/// </para>
///
/// <para>
/// The bug store has ONE move table, as it has one lifecycle; each backlog type
/// has its own, as each walks its own ladder. A store or type with no table
/// moves exactly as it always has. <c>from: "*"</c> offers a move from every
/// status but its target.
/// </para>
///
/// <para>
/// A flow is a FlexDesk outline graph (<c>{nodes, connections}</c>) over the
/// step catalogue BugDesk supplies (ui/js/ticketdesk/workflow.js). BugDesk runs
/// it in the page, where the prompts are, and saves the result as ONE write, so
/// a cancelled prompt leaves the record as it was. This class only checks that
/// what is saved names fields and statuses that exist; it runs nothing.
/// </para>
/// </summary>
static class RecordWorkflow
{
    public record Problem(string Where, string Message, string? NodeId = null);

    /// <summary>The named flows of one workflow, by id.</summary>
    sealed class Flows : Dictionary<string, (string Store, string Label, JsonNode? Graph, string[] Types)> { }

    /// <summary>The step types a flow may hold — the catalogue's ids.</summary>
    public static readonly HashSet<string> StepTypes = new()
    {
        "start", "end", "condition", "require-message", "prompt", "set-field", "clear-field", "add-comment", "set-status",
        "add-link",
    };

    /// <summary>The verbs a link may have (ui/js/ticketdesk/links.js), and so an
    /// "Add a link" step (STORY-0050).</summary>
    public static readonly string[] LinkVerbs =
        { "duplicates", "blocks", "blocked-by", "requires", "caused-by", "relates-to", "implements" };

    /// <summary>Built-in fields a step may set or clear, per store.</summary>
    public static readonly Dictionary<string, string[]> SettableBuiltins = new()
    {
        ["bugs"] = new[] { "assignee", "severity", "subsystem", "labels", "title", "resolution" },
        ["backlog"] = new[] { "assignee", "phase", "due", "points", "subsystem", "labels", "title", "resolution" },
    };

    /// <summary>Fields a condition may read, beyond the settable ones.</summary>
    static readonly string[] Readable = { "status", "type", "reporter", "assignee", "title" };

    static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "";

    /// <summary>Every status a record of this store and type may hold.</summary>
    static HashSet<string> Statuses(RecordSchema.Schema schema, string store, IEnumerable<string> types)
    {
        var set = new HashSet<string>();
        foreach (var type in types)
        {
            if (store == "bugs") foreach (var (n, _) in RecordSchema.BuiltinStatuses["bugs"]) set.Add(n);
            else { foreach (var s in BacklogItem.LadderFor(type)) set.Add(s); set.Add("dropped"); }
            foreach (var s in schema.For(store, type).Statuses) set.Add(s.Name);
        }
        return set;
    }

    static HashSet<string> Fields(RecordSchema.Schema schema, string store, IEnumerable<string> types, bool readable)
    {
        var set = new HashSet<string>(SettableBuiltins[store]);
        if (readable) foreach (var r in Readable) set.Add(r);
        foreach (var type in types)
            foreach (var f in schema.For(store, type).Fields) set.Add(f.Name);
        return set;
    }

    /// <summary>
    /// Check a whole <c>workflow</c> node against the schema. Returns every
    /// problem; an empty list means it may be saved.
    /// </summary>
    public static List<Problem> Check(JsonNode? node, RecordSchema.Schema schema)
    {
        var problems = new List<Problem>();
        if (node is null) return problems;
        if (node is not JsonObject root) { problems.Add(new("workflow", "workflow is not an object.")); return problems; }

        var flows = new Flows();
        if (root["flows"] is JsonNode flowsNode)
        {
            if (flowsNode is not JsonArray list) problems.Add(new("workflow.flows", "flows is not a list."));
            else
                for (var i = 0; i < list.Count; i++)
                {
                    var f = list[i];
                    var w = $"workflow.flows[{i}]";
                    var id = Str(f?["id"]);
                    var label = Str(f?["label"]);
                    var store = Str(f?["store"]);
                    if (label.Length == 0) problems.Add(new(w, "a flow needs a name."));
                    if (!FlowId.IsMatch(id)) { problems.Add(new(w, $"'{label}': the flow id '{id}' must start with a letter or digit and use only a-z, 0-9 and -.")); continue; }
                    if (store != AnyStore && !RecordSchema.TypesOf.ContainsKey(store)) { problems.Add(new(w, $"'{label}' is for '{store}', which is not bugs, backlog or any.")); continue; }
                    if (flows.ContainsKey(id)) { problems.Add(new(w, $"two flows have the id '{id}'.")); continue; }
                    // Which of its store's types it is available to (STORY-0030); none listed is all.
                    var only = (f?["types"] as JsonArray)?.Select(Str).Where(x => x.Length > 0).Distinct().ToArray() ?? Array.Empty<string>();
                    var bad = only.Where(t => store == AnyStore
                        ? !RecordSchema.TypesOf.Values.Any(ts => ts.Contains(t))
                        : !RecordSchema.TypesOf[store].Contains(t)).ToList();
                    if (bad.Count > 0) problems.Add(new(w, $"'{label}' is available to {string.Join(", ", bad.Select(x => $"'{x}'"))}, which {(bad.Count == 1 ? "is" : "are")} not a type of {store}."));
                    flows[id] = (store, label.Length > 0 ? label : id, f?["flow"], only);
                    if (store != AnyStore)
                        CheckFlow(f?["flow"], store, only.Length > 0 && bad.Count == 0 ? only : RecordSchema.TypesOf[store], w, label, schema, problems);
                    else
                    {
                        // For any record: what it does must make sense for both
                        // stores. The same problem found in both is said once.
                        var both = new List<Problem>();
                        foreach (var (s, types) in RecordSchema.TypesOf)
                            CheckFlow(f?["flow"], s, types, w, label, schema, both);
                        problems.AddRange(both.Distinct());
                    }
                }
        }

        if (root["bugs"] is JsonObject bugs)
            CheckMoves(bugs["moves"], "bugs", RecordSchema.TypesOf["bugs"], "workflow.bugs", schema, problems, flows);
        if (root["backlog"] is JsonObject backlog)
            foreach (var (type, spec) in backlog)
            {
                if (!RecordSchema.TypesOf["backlog"].Contains(type)) { problems.Add(new($"workflow.backlog.{type}", $"unknown backlog type '{type}'.")); continue; }
                CheckMoves(spec?["moves"], "backlog", new[] { type }, $"workflow.backlog.{type}", schema, problems, flows);
            }
        if (root["actions"] is JsonObject actions)
            foreach (var (store, byType) in actions)
            {
                if (!RecordSchema.TypesOf.ContainsKey(store) || byType is not JsonObject types) continue;
                foreach (var (type, list) in types)
                {
                    var where = $"workflow.actions.{store}.{type}";
                    if (!RecordSchema.TypesOf[store].Contains(type)) { problems.Add(new(where, $"unknown {store} type '{type}'.")); continue; }
                    if (list is not JsonArray arr) continue;
                    var known = Statuses(schema, store, new[] { type });
                    var ids = new HashSet<string>();
                    for (var i = 0; i < arr.Count; i++)
                    {
                        var a = arr[i];
                        var label = Str(a?["label"]);
                        var w = $"{where}[{i}]";
                        if (label.Length == 0) problems.Add(new(w, "an action needs a name."));
                        var id = Str(a?["id"]);
                        if (id.Length > 0 && !ids.Add(id)) problems.Add(new(w, $"two actions are called '{id}'."));
                        if (a?["when"] is JsonArray when)
                            foreach (var s in when.Select(Str))
                                if (s != "*" && !known.Contains(s)) problems.Add(new(w, $"'{label}' is offered in '{s}', which is not a status of a {type}."));
                        // The same action on several types shares one flow: say which type
                        // a problem is on, or three lines read the same.
                        var typeWord = store == "bugs" && type == "task" ? "chore" : type;
                        CheckRef(a?["flow"], store, new[] { type }, w, $"{typeWord} › {label}", schema, problems, action: true, flows);
                    }
                }
            }
        if (root["types"] is JsonNode typesNode) CheckTypes(typesNode, schema, problems, flows);
        if (root["massActions"] is JsonNode mass) CheckMassActions(mass, root["actions"], root["types"], problems);
        return problems;
    }

    /// <summary>
    /// STORY-0029. <c>massActions.&lt;store&gt;.&lt;type&gt;</c>: what a multi-row
    /// selection of that type offers — <c>"assignee"</c>, <c>"status"</c> and
    /// <c>"action:&lt;id&gt;"</c>, one of that type's custom actions. A type not
    /// listed offers the first two (ui/js/ticketdesk/mass_actions.js).
    /// </summary>
    /// <summary>
    /// STORY-0030. <c>types.&lt;store&gt;.&lt;type&gt;</c>: a record type's whole list of
    /// actions, <c>{id, label, when, flow}</c>, once the project changed it. An
    /// action whose flow changes the status is one of the type's moves.
    /// </summary>
    static void CheckTypes(JsonNode node, RecordSchema.Schema schema, List<Problem> problems, Flows flows)
    {
        if (node is not JsonObject stores) { problems.Add(new("workflow.types", "types is not an object.")); return; }
        foreach (var (store, byType) in stores)
        {
            var where = $"workflow.types.{store}";
            if (!RecordSchema.TypesOf.ContainsKey(store)) { problems.Add(new(where, $"'{store}' is not bugs or backlog.")); continue; }
            if (byType is not JsonObject types) { problems.Add(new(where, "not an object of record types.")); continue; }
            foreach (var (type, list) in types)
            {
                var w0 = $"{where}.{type}";
                if (!RecordSchema.TypesOf[store].Contains(type)) { problems.Add(new(w0, $"unknown {store} type '{type}'.")); continue; }
                if (list is not JsonArray arr) { problems.Add(new(w0, "not a list of actions.")); continue; }
                var known = Statuses(schema, store, new[] { type });
                var typeWord = store == "bugs" && type == "task" ? "chore" : type;
                var ids = new HashSet<string>();
                for (var i = 0; i < arr.Count; i++)
                {
                    var a = arr[i];
                    var w = $"{w0}[{i}]";
                    var label = Str(a?["label"]);
                    var id = Str(a?["id"]);
                    if (label.Length == 0) problems.Add(new(w, $"an action of a {typeWord} needs a name."));
                    if (!FlowId.IsMatch(id)) problems.Add(new(w, $"'{label}': the action id '{id}' must start with a letter or digit and use only a-z, 0-9 and -."));
                    else if (!ids.Add(id)) problems.Add(new(w, $"two actions of a {typeWord} have the id '{id}'."));
                    if (a?["when"] is JsonArray when)
                        foreach (var st in when.Select(Str))
                            if (st != "*" && !known.Contains(st)) problems.Add(new(w, $"'{label}' is offered in '{st}', which is not a status of a {typeWord}."));
                    CheckRef(a?["flow"], store, new[] { type }, w, $"{typeWord} › {label}", schema, problems, action: true, flows);
                }
            }
        }
    }

    static void CheckMassActions(JsonNode mass, JsonNode? actions, JsonNode? ownTypes, List<Problem> problems)
    {
        if (mass is not JsonObject stores) { problems.Add(new("workflow.massActions", "massActions is not an object.")); return; }
        foreach (var (store, byType) in stores)
        {
            var where = $"workflow.massActions.{store}";
            if (!RecordSchema.TypesOf.ContainsKey(store)) { problems.Add(new(where, $"'{store}' is not bugs or backlog.")); continue; }
            if (byType is not JsonObject types) { problems.Add(new(where, "not an object of record types.")); continue; }
            foreach (var (type, list) in types)
            {
                var w = $"{where}.{type}";
                if (!RecordSchema.TypesOf[store].Contains(type)) { problems.Add(new(w, $"unknown {store} type '{type}'.")); continue; }
                if (list is not JsonArray arr) { problems.Add(new(w, "not a list.")); continue; }
                var ids = new HashSet<string>();
                // A type's own list (STORY-0030) when it has one, else its older custom actions.
                if ((ownTypes?[store]?[type] ?? actions?[store]?[type]) is JsonArray acts)
                    foreach (var a in acts) { var id = Str(a?["id"]); if (id.Length > 0) ids.Add(id); }
                var seen = new HashSet<string>();
                for (var i = 0; i < arr.Count; i++)
                {
                    var entry = Str(arr[i]);
                    if (!seen.Add(entry)) { problems.Add(new($"{w}[{i}]", $"'{entry}' is listed twice.")); continue; }
                    if (entry is "assignee" or "status") continue;
                    if (entry.StartsWith("action:") && ids.Contains(entry[7..])) continue;
                    problems.Add(new($"{w}[{i}]", entry.StartsWith("action:")
                        ? $"'{entry[7..]}' is not a custom action of a {type}."
                        : $"'{entry}' is not a mass action (assignee, status or action:<id>)."));
                }
            }
        }
    }

    static void CheckMoves(JsonNode? movesNode, string store, string[] types, string where,
                           RecordSchema.Schema schema, List<Problem> problems, Flows flows)
    {
        if (movesNode is null) return;
        if (movesNode is not JsonArray moves) { problems.Add(new(where, "moves is not a list.")); return; }
        var known = Statuses(schema, store, types);
        for (var i = 0; i < moves.Count; i++)
        {
            var m = moves[i];
            var w = $"{where}.moves[{i}]";
            var from = Str(m?["from"]);
            var to = Str(m?["to"]);
            var label = Str(m?["label"]);
            if (label.Length == 0) problems.Add(new(w, "a move needs a label."));
            if (from != "*" && !known.Contains(from))
                problems.Add(new(w, $"'{label}' starts from '{from}', which is not a status here."));
            if (!known.Contains(to))
                problems.Add(new(w, store == "backlog"
                    ? $"'{label}' goes to '{to}', which is not on a {types[0]}'s ladder ({string.Join(" → ", BacklogItem.LadderFor(types[0]))}) or among its custom statuses."
                    : $"'{label}' goes to '{to}', which is not a status here."));
            if (from == to && from != "*") problems.Add(new(w, $"'{label}' goes from '{from}' to itself."));
            // A transition's flow shows its status change as a step (STORY-0028);
            // it may branch to others, but one way through must be the move's own.
            CheckRef(m?["flow"], store, types, w, label, schema, problems, action: true, flows);
            var graph = m?["flow"] is JsonValue fv && fv.TryGetValue<string>(out var fid) && flows.TryGetValue(fid.Trim(), out var named)
                ? named.Graph : m?["flow"] as JsonObject;
            var sets = (graph?["nodes"] as JsonArray)?.Where(n => Str(n?["type"]) == "set-status")
                .Select(n => Str(n?["config"]?["status"])).ToList() ?? new();
            if (sets.Count > 0 && to.Length > 0 && !sets.Contains(to))
                problems.Add(new(w, $"'{label}' goes to '{to}', but its flow changes the status to {string.Join(" or ", sets.Select(x => $"'{x}'"))}."));
        }
    }

    /// <summary>A flow's <c>store</c> when it is for any record, bug or backlog item.</summary>
    const string AnyStore = "any";

    static readonly System.Text.RegularExpressions.Regex FlowId = new("^[a-z0-9][a-z0-9-]{0,63}$");

    /// <summary>A row's <c>flow</c>: a named flow's id, or a graph stored inline.</summary>
    static void CheckRef(JsonNode? flow, string store, string[] types, string where, string owner,
                         RecordSchema.Schema schema, List<Problem> problems, bool action, Flows flows)
    {
        if (flow is null) return;
        if (flow is JsonValue v && v.TryGetValue<string>(out var id))
        {
            id = id.Trim();
            if (id.Length == 0) return;
            if (!flows.TryGetValue(id, out var named))
            {
                problems.Add(new(where, $"'{owner}' uses the flow '{id}', which does not exist."));
                return;
            }
            if (named.Store != store && named.Store != AnyStore)
            {
                problems.Add(new(where, $"'{owner}' uses '{named.Label}', a flow for {named.Store}, not {store}."));
                return;
            }
            var notFor = named.Types.Length > 0 ? types.Where(t => !named.Types.Contains(t)).ToList() : new List<string>();
            if (notFor.Count > 0)
            {
                problems.Add(new(where, $"'{owner}' uses '{named.Label}', which is available to {string.Join(", ", named.Types)} only."));
                return;
            }
            CheckFlow(named.Graph, store, types, where, $"{owner}' through '{named.Label}", schema, problems);
            return;
        }
        CheckFlow(flow, store, types, where, owner, schema, problems);
    }

    static void CheckFlow(JsonNode? flow, string store, string[] types, string where, string owner,
                          RecordSchema.Schema schema, List<Problem> problems)
    {
        if (flow is null) return;
        if (flow is not JsonObject f || f["nodes"] is not JsonArray nodes) { problems.Add(new(where, $"the flow of '{owner}' is not a graph.")); return; }
        var settable = Fields(schema, store, types, readable: false);
        var readableFields = Fields(schema, store, types, readable: true);
        var statuses = Statuses(schema, store, types);
        foreach (var n in nodes)
        {
            var id = Str(n?["id"]);
            var type = Str(n?["type"]);
            var cfg = n?["config"] as JsonObject;
            if (!StepTypes.Contains(type)) { problems.Add(new(where, $"'{owner}': step '{id}' is a '{type}', which BugDesk cannot run.", id)); continue; }
            switch (type)
            {
                case "set-field" or "clear-field":
                {
                    var field = Str(cfg?["field"]);
                    if (!settable.Contains(field))
                        problems.Add(new(where, $"'{owner}': step '{id}' names the field '{field}', which a flow cannot set here.", id));
                    // A resolution is one of its words; an inserted answer is checked when it runs.
                    var value = Str(cfg?["value"]);
                    if (type == "set-field" && field == "resolution" && !value.Contains("${") && !RecordSchema.Resolutions.Contains(value))
                        problems.Add(new(where, $"'{owner}': step '{id}' sets the resolution to '{value}', which is not one of {string.Join(", ", RecordSchema.Resolutions)}.", id));
                    break;
                }
                case "condition":
                {
                    var field = Str(cfg?["field"]);
                    if (!readableFields.Contains(field))
                        problems.Add(new(where, $"'{owner}': condition '{id}' reads '{field}', which is not a field here.", id));
                    break;
                }
                case "set-status":
                {
                    var status = Str(cfg?["status"]);
                    if (!statuses.Contains(status))
                        problems.Add(new(where, $"'{owner}': step '{id}' moves to '{status}', which is not a status here.", id));
                    break;
                }
                case "prompt":
                {
                    if (Str(cfg?["kind"]) == "choice" && (cfg?["choices"] as JsonArray)?.Count is null or 0)
                        problems.Add(new(where, $"'{owner}': prompt '{id}' offers a choice with nothing to choose.", id));
                    break;
                }
                case "add-link":
                {
                    var verb = Str(cfg?["verb"]);
                    if (!LinkVerbs.Contains(verb))
                        problems.Add(new(where, $"'{owner}': step '{id}' adds a '{verb}' link, which is not a link ({string.Join(", ", LinkVerbs)}).", id));
                    if (Str(cfg?["target"]).Length == 0)
                        problems.Add(new(where, $"'{owner}': step '{id}' adds a link to nothing; give it the record to point at.", id));
                    break;
                }
            }
        }
    }
}
