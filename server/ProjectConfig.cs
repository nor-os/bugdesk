using System.Text.Json;
using System.Text.Json.Nodes;

/// <summary>
/// The project's SHARED config — <c>bugdesk.json</c>, beside the stores, and
/// committed.
///
/// <para>
/// This is the opposite of <see cref="UserStore"/>. That file is per-person and
/// git-ignored because two people must not overwrite each other's identity.
/// THIS one is the part everybody has to agree on: who works on this repo. An
/// assignee dropdown offering only "me and my agent" is useless the moment a
/// bug belongs to somebody else, and a list each person maintains privately
/// would have them assigning work to names their colleagues cannot see.
/// </para>
///
/// <code>
/// your-project/
///   bugs/ backlog/              tracked
///   .bugdesk/
///     .gitignore                ignores this directory EXCEPT project.json
///     project.json              tracked — the collaborator roster
///     user-alice.json           git-ignored — who *I* am, my filters, my layout
/// </code>
///
/// <para>
/// Both halves share one directory, and the <c>.gitignore</c> inside it is what
/// distinguishes them — at the exact point where the distinction has an effect.
/// A root <c>bugdesk.json</c> from before the move is still used when one
/// exists; see <c>ResolveProjectConfig</c> in Program.cs.
/// </para>
///
/// <para>
/// Each collaborator carries a human name and the name their AI assistant signs
/// comments with. The agent name defaults to <c>&lt;name&gt;_agent</c> — derived
/// rather than asked for, because "what should my agent be called" is a question
/// with no interesting answer and every project that had to answer it would
/// answer it differently.
/// </para>
///
/// <para>
/// The roster grows on its own: setting your name adds you, and assigning to a
/// name that is not on it adds that person. The <c>/bugs</c>, <c>/backlog</c>
/// and <c>/tracker</c> skills read it to know who they may assign to, and can
/// add people they find in the git history.
/// </para>
/// </summary>
class ProjectConfig
{
    readonly object _gate = new();

    public string Path { get; }

    /// <summary>
    /// Whether each person's assistant is a thing you can assign work TO.
    ///
    /// <para>
    /// False in TRACKER mode, and that is the whole difference. A tracker is a
    /// record of work handed to other PEOPLE — colleagues, vendors, counterparts
    /// — and none of them has an assistant in this store; a
    /// <c>&lt;name&gt;_agent</c> beside every one of them is an entry in every
    /// picker that can never legitimately be chosen. In a code repo it is the
    /// opposite: the agent is the half of the pair that does most of the work.
    /// </para>
    /// </summary>
    public bool AgentsAssignable { get; }

    public ProjectConfig(string path, bool agentsAssignable = true)
    {
        Path = path;
        AgentsAssignable = agentsAssignable;
    }

    /// <summary>The conventional agent name for a person. One rule, everywhere.</summary>
    public static string AgentNameFor(string human) =>
        string.IsNullOrWhiteSpace(human) ? "agent" : $"{UserStore.SlugOf(human)}_agent";

    /// <summary>
    /// The roster, oldest entry first. Never throws: a malformed or absent file
    /// reads as an empty roster, because a broken config must not take the whole
    /// UI's assignee picker down with it.
    /// </summary>
    public JsonArray Collaborators()
    {
        var doc = Read();
        return doc?["collaborators"] as JsonArray is { } arr
            ? (JsonArray)arr.DeepClone()
            : new JsonArray();
    }

    /// <summary>Every assignable name — each collaborator and their agent.</summary>
    public List<string> Assignees()
    {
        var names = new List<string>();
        foreach (var c in Collaborators())
        {
            var name = c?["name"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(name)) names.Add(name);
            if (!AgentsAssignable) continue;
            var agent = c?["agent"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(agent)) names.Add(agent);
        }
        return names.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// Add or update one collaborator, matched case-insensitively on the human
    /// name — "Alice" and "alice" are one person, and a second entry for them
    /// would silently split the assignee list in two.
    /// </summary>
    /// <returns>the stored entry.</returns>
    public JsonObject Upsert(string name, string? agent = null)
    {
        lock (_gate)
        {
            var doc = Read() ?? new JsonObject();
            var list = doc["collaborators"] as JsonArray ?? new JsonArray();

            JsonObject? found = null;
            foreach (var c in list)
            {
                if (c is JsonObject o &&
                    string.Equals(o["name"]?.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase))
                { found = o; break; }
            }

            // An unnamed agent is DERIVED where agents are assignable, so every
            // person's assistant has a distinguishable name. Where they are NOT
            // — a tracker, whose entries are colleagues and vendors — the field
            // is left empty rather than filled with a name for an assistant
            // nobody has. Writing one anyway is what put a `<name>_agent` beside
            // every person in a store that has no agents in it.
            var derived = AgentsAssignable ? AgentNameFor(name) : "";
            if (found is null)
            {
                found = new JsonObject
                {
                    ["name"] = name.Trim(),
                    ["agent"] = string.IsNullOrWhiteSpace(agent) ? derived : agent!.Trim(),
                    ["added"] = Md.Today(),
                };
                list.Add(found);
            }
            else
            {
                found["name"] = name.Trim();
                if (!string.IsNullOrWhiteSpace(agent)) found["agent"] = agent!.Trim();
                else if (string.IsNullOrWhiteSpace(found["agent"]?.GetValue<string>()))
                    found["agent"] = derived;
            }

            doc["collaborators"] = list;
            Write(doc);
            return (JsonObject)found.DeepClone();
        }
    }

    /// <summary>Replace the whole roster — what the Settings editor saves.</summary>
    public JsonArray SetCollaborators(JsonArray next)
    {
        lock (_gate)
        {
            var doc = Read() ?? new JsonObject();
            var cleaned = new JsonArray();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var c in next)
            {
                var name = (c?["name"]?.GetValue<string>() ?? "").Trim();
                if (name.Length == 0 || !seen.Add(name)) continue;   // blank or duplicate
                var agent = (c?["agent"]?.GetValue<string>() ?? "").Trim();
                cleaned.Add(new JsonObject
                {
                    ["name"] = name,
                    ["agent"] = agent.Length > 0 ? agent : AgentNameFor(name),
                    ["added"] = c?["added"]?.GetValue<string>() ?? Md.Today(),
                });
            }
            doc["collaborators"] = cleaned;
            Write(doc);
            return (JsonArray)cleaned.DeepClone();
        }
    }

    /// <summary>The whole document, for the UI to render and for future keys.</summary>
    public JsonObject Document() => Read() ?? new JsonObject { ["collaborators"] = new JsonArray() };

    JsonObject? Read()
    {
        if (!File.Exists(Path)) return null;
        try { return JsonNode.Parse(File.ReadAllText(Path)) as JsonObject; }
        catch (JsonException) { return null; }
    }

    void Write(JsonObject doc)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        File.WriteAllText(Path, doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }
}
