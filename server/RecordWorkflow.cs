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
/// that uses it, against that row's types — and only an action's flow may move
/// to a status, since a move IS the status change.
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
    sealed class Flows : Dictionary<string, (string Store, string Label, JsonNode? Graph)> { }

    /// <summary>The step types a flow may hold — the catalogue's ids.</summary>
    public static readonly HashSet<string> StepTypes = new()
    {
        "start", "end", "condition", "require-message", "prompt", "set-field", "clear-field", "add-comment", "set-status",
    };

    /// <summary>Built-in fields a step may set or clear, per store.</summary>
    public static readonly Dictionary<string, string[]> SettableBuiltins = new()
    {
        ["bugs"] = new[] { "assignee", "severity", "subsystem", "labels", "title" },
        ["backlog"] = new[] { "assignee", "phase", "due", "points", "subsystem", "labels", "title" },
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
                    flows[id] = (store, label.Length > 0 ? label : id, f?["flow"]);
                    if (store != AnyStore)
                        CheckFlow(f?["flow"], store, RecordSchema.TypesOf[store], w, label, schema, problems, allowStatus: true);
                    else
                    {
                        // For any record: what it does must make sense for both
                        // stores. The same problem found in both is said once.
                        var both = new List<Problem>();
                        foreach (var (s, types) in RecordSchema.TypesOf)
                            CheckFlow(f?["flow"], s, types, w, label, schema, both, allowStatus: true);
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
        if (root["massActions"] is JsonNode mass) CheckMassActions(mass, root["actions"], problems);
        return problems;
    }

    /// <summary>
    /// STORY-0029. <c>massActions.&lt;store&gt;.&lt;type&gt;</c>: what a multi-row
    /// selection of that type offers — <c>"assignee"</c>, <c>"status"</c> and
    /// <c>"action:&lt;id&gt;"</c>, one of that type's custom actions. A type not
    /// listed offers the first two (ui/js/ticketdesk/mass_actions.js).
    /// </summary>
    static void CheckMassActions(JsonNode mass, JsonNode? actions, List<Problem> problems)
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
                if (actions?[store]?[type] is JsonArray acts)
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
            CheckRef(m?["flow"], store, types, w, label, schema, problems, action: false, flows);
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
            CheckFlow(named.Graph, store, types, where, $"{owner}' through '{named.Label}", schema, problems, allowStatus: action);
            return;
        }
        CheckFlow(flow, store, types, where, owner, schema, problems, allowStatus: action);
    }

    static void CheckFlow(JsonNode? flow, string store, string[] types, string where, string owner,
                          RecordSchema.Schema schema, List<Problem> problems, bool allowStatus)
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
                    if (!allowStatus)
                    {
                        problems.Add(new(where, $"'{owner}': step '{id}' moves to a status, which only an action's flow may do: the move itself is the status change.", id));
                        break;
                    }
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
            }
        }
    }
}
