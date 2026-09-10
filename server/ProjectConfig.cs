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
///   bugs/ backlog/          tracked
///   bugdesk.json            tracked — the collaborator roster
///   .bugdesk/               git-ignored — who *I* am, my filters, my layout
/// </code>
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
/// The roster grows on its own: setting your name adds you. The
/// <c>/bugs</c> and <c>/backlog</c> skills read it to know who they may assign
/// to, and can add people they find in the git history.
/// </para>
/// </summary>
class ProjectConfig
{
    readonly object _gate = new();

    public string Path { get; }

    public ProjectConfig(string path) { Path = path; }

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

            if (found is null)
            {
                found = new JsonObject
                {
                    ["name"] = name.Trim(),
                    ["agent"] = string.IsNullOrWhiteSpace(agent) ? AgentNameFor(name) : agent!.Trim(),
                    ["added"] = Md.Today(),
                };
                list.Add(found);
            }
            else
            {
                found["name"] = name.Trim();
                if (!string.IsNullOrWhiteSpace(agent)) found["agent"] = agent!.Trim();
                else if (string.IsNullOrWhiteSpace(found["agent"]?.GetValue<string>()))
                    found["agent"] = AgentNameFor(name);
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
