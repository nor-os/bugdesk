using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

// BugDesk bridge: serves the FlexDesk UI and exposes two directories of markdown
// records as JSON — the BUG store (BUGDESK_BUGS, default ./bugs) and the BACKLOG
// store (BUGDESK_BACKLOG, default ./backlog). The markdown files are the source
// of truth; this process only reads and writes them.
//
// Per-user configuration (who you are, your filters, your workspace layout) is
// NOT in either store — it lives in a git-ignored .bugdesk/ directory beside
// them. See UserConfig.cs for why.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// ---- Locate the stores ----------------------------------------------------
string bugsDir = ResolveBugsDir(app.Environment.ContentRootPath);
string backlogDir = ResolveBacklogDir(bugsDir);
string uiDir = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "ui"));
app.Logger.LogInformation("BugDesk: bugs={bugs} backlog={backlog} ui={ui}", bugsDir, backlogDir, uiDir);

// ---- Authorship (configurable — see README "Authorship") ------------------
// BugDesk's lifecycle assumes exactly two roles: a human who files/triages/tests
// records through this UI, and an agent who investigates them (typically an AI
// coding assistant driven through the /bugs and /backlog skills). Neither name is
// fixed. The human's name normally comes from the per-user profile the first-run
// screen writes; BUGDESK_HUMAN/BUGDESK_AGENT override it for CI and for two
// people sharing one checkout.
var users = new UserStore(
    ResolveConfigDir(bugsDir),
    Environment.GetEnvironmentVariable("BUGDESK_USER"),
    Environment.GetEnvironmentVariable("BUGDESK_HUMAN"),
    Environment.GetEnvironmentVariable("BUGDESK_AGENT"));
app.Logger.LogInformation("BugDesk: config={config} user={user}",
    users.ConfigDir, users.ActiveSlug ?? "(unconfigured — the UI will ask)");

// The SHARED roster — who works on this repo. Committed, unlike the per-user
// profile: an assignee dropdown offering only "me and my agent" is useless the
// moment a record belongs to somebody else.
var project = new ProjectConfig(ResolveProjectConfig(bugsDir));
app.Logger.LogInformation("BugDesk: project={project}", project.Path);

// Pre-profile UI state: a single shared filters.json. Read once, folded into
// whichever profile is active, and never written again. Declared here because
// the first-run handler below migrates on the profile it has just created.
string legacyFiltersPath = Path.Combine(ResolveStateDir(app.Environment.ContentRootPath), "filters.json");
users.MigrateLegacyFilters(legacyFiltersPath);

// ---- Static UI ------------------------------------------------------------
if (Directory.Exists(uiDir))
{
    var files = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(uiDir);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files, RequestPath = "" });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = files,
        RequestPath = "",
        ServeUnknownFileTypes = true, // .js modules, .css, etc. all served
        OnPrepareResponse = ctx =>
        {
            ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        }
    });
}

// ---- Attachments ----------------------------------------------------------
// Images pasted or dropped into a description / comment land in
// <bugsDir>/attachments and are referenced from the markdown as
// `/attachments/<name>`. They live WITH the store on purpose: a screenshot is
// part of the record, and keeping it beside the .md means the two travel
// together in git rather than rotting as a dead link. Backlog items share the
// directory — an attachment is addressed by content hash, so which store
// referenced it first does not matter.
string attachDir = Path.Combine(bugsDir, "attachments");
{
    Directory.CreateDirectory(attachDir);
    var attachFiles = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(attachDir);
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = attachFiles,
        RequestPath = "/attachments",
        ServeUnknownFileTypes = false, // images only — never serve arbitrary blobs
    });
}

// ---- API ------------------------------------------------------------------
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };

// Upload one image. Body: { name, contentType, data } where `data` is base64
// (the UI reads pasted/dropped files with FileReader, so there is no multipart
// path to maintain). Returns the URL to reference from markdown.
app.MapPost("/api/attachments", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var root = doc.RootElement;
    var b64 = root.TryGetProperty("data", out var d) ? d.GetString() : null;
    if (string.IsNullOrEmpty(b64))
        return Results.Json(new { ok = false, error = "no data" }, json, statusCode: 400);

    var contentType = root.TryGetProperty("contentType", out var ct) ? ct.GetString() ?? "" : "";
    var ext = ExtensionForImage(contentType, root.TryGetProperty("name", out var n) ? n.GetString() : null);
    if (ext is null)
        return Results.Json(new { ok = false, error = "unsupported image type" }, json, statusCode: 415);

    byte[] bytes;
    try { bytes = Convert.FromBase64String(b64); }
    catch (FormatException) { return Results.Json(new { ok = false, error = "data is not base64" }, json, statusCode: 400); }
    if (bytes.Length > 12 * 1024 * 1024)
        return Results.Json(new { ok = false, error = "image larger than 12 MB" }, json, statusCode: 413);

    // Content-addressed: the same screenshot pasted twice is stored once, and
    // the name can never collide or escape the directory.
    var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes))[..16].ToLowerInvariant();
    var fileName = $"{hash}{ext}";
    var full = Path.Combine(attachDir, fileName);
    if (!File.Exists(full)) await File.WriteAllBytesAsync(full, bytes);

    return Results.Json(new { ok = true, url = $"/attachments/{fileName}", name = fileName }, json);
});

// ---- Bugs -----------------------------------------------------------------

app.MapGet("/api/bugs", () =>
{
    var list = LoadAll(bugsDir).OrderBy(b => b.Pri).ThenByDescending(b => b.Updated).Select(b => b.ToSummary()).ToList();
    return Results.Json(new { ok = true, bugs = list }, json);
});

app.MapGet("/api/bugs/{id:int}", (int id) =>
{
    var bug = LoadOne(bugsDir, id);
    return bug is null
        ? Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404)
        : Results.Json(new { ok = true, bug }, json);
});

app.MapPost("/api/bugs/{id:int}", async (int id, HttpRequest req) =>
{
    var path = BugPath(bugsDir, id);
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var patch = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var text = await File.ReadAllTextAsync(path);
    foreach (var (k, v) in patch)
    {
        var key = k.ToLowerInvariant();
        // assignee is EXPLICIT — set by the user (the reassign control), never derived.
        if (key is "status" or "severity" or "subsystem" or "type" or "title" or "assignee")
            text = Md.SetFrontmatter(text, key, v.ValueKind == JsonValueKind.String ? v.GetString()! : v.ToString());
        else if (key is "labels" or "links" && v.ValueKind == JsonValueKind.Array)
            text = Md.SetFrontmatter(text, key, Md.ListValue(v.EnumerateArray().Select(e => e.GetString() ?? "")));
    }
    text = Md.SetFrontmatter(text, "updated", Md.Today());
    await File.WriteAllTextAsync(path, text);
    return Results.Json(new { ok = true, bug = LoadOne(bugsDir, id) }, json);
});

app.MapPost("/api/bugs/{id:int}/comments", async (int id, HttpRequest req) =>
{
    var path = BugPath(bugsDir, id);
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var author = body.TryGetValue("author", out var a) ? a.GetString() : users.HumanAuthor;
    var comment = body.TryGetValue("body", out var b) ? b.GetString() : "";
    if (string.IsNullOrWhiteSpace(comment)) return Results.Json(new { ok = false, error = "empty comment" }, json, statusCode: 400);

    var text = Md.AppendComment(await File.ReadAllTextAsync(path), author ?? users.HumanAuthor, comment!);
    await File.WriteAllTextAsync(path, text);
    return Results.Json(new { ok = true, bug = LoadOne(bugsDir, id) }, json);
});

// Create a new bug. The ID is assigned automatically (max existing + 1) — the client
// never supplies it. Returns the created bug (with its new id) so the UI can open it.
app.MapPost("/api/bugs", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    string Get(string k, string def = "") =>
        body.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : def;

    var title = Get("title").Trim();
    if (string.IsNullOrWhiteSpace(title))
        return Results.Json(new { ok = false, error = "title required" }, json, statusCode: 400);

    var nextId = LoadAll(bugsDir).Select(b => b.Id).DefaultIfEmpty(0).Max() + 1;
    var labels = body.TryGetValue("labels", out var lv) && lv.ValueKind == JsonValueKind.Array
        ? string.Join(", ", lv.EnumerateArray().Select(e => e.GetString()))
        : "";
    // Relationships can be set while filing, so a bug can be born "duplicates #52".
    var links = body.TryGetValue("links", out var kv) && kv.ValueKind == JsonValueKind.Array
        ? string.Join(", ", kv.EnumerateArray().Select(e => e.GetString()))
        : "";
    var description = Get("description").Trim();

    var sb = new StringBuilder();
    sb.Append("---\n");
    sb.Append($"id: {nextId}\n");
    sb.Append($"title: \"{Md.Quote(title)}\"\n");
    sb.Append("status: open\n");
    sb.Append($"severity: {Get("severity", "medium")}\n");
    sb.Append($"type: {Get("type", "bug")}\n");
    sb.Append($"subsystem: {Get("subsystem", "unsorted")}\n");
    sb.Append($"assignee: {Get("assignee", users.HumanAuthor)}\n");
    sb.Append($"labels: [{labels}]\n");
    sb.Append($"links: [{links}]\n");
    sb.Append($"created: {Md.Today()}\n");
    sb.Append($"updated: {Md.Today()}\n");
    sb.Append("---\n\n## Description\n\n");
    sb.Append(string.IsNullOrWhiteSpace(description) ? "_(no description provided)_" : description);
    sb.Append('\n');

    await File.WriteAllTextAsync(BugPath(bugsDir, nextId), sb.ToString());
    return Results.Json(new { ok = true, bug = LoadOne(bugsDir, nextId) }, json);
});

app.MapGet("/api/meta", () =>
{
    var all = LoadAll(bugsDir);
    return Results.Json(new
    {
        ok = true,
        count = all.Count,
        byStatus = all.GroupBy(b => b.Status).ToDictionary(g => g.Key, g => g.Count()),
        bySubsystem = all.GroupBy(b => b.Subsystem).ToDictionary(g => g.Key, g => g.Count()),
        byAssignee = all.GroupBy(b => b.Assignee).ToDictionary(g => g.Key, g => g.Count()),
        bySeverity = all.GroupBy(b => b.Severity).ToDictionary(g => g.Key, g => g.Count()),
    }, json);
});

// ---- Backlog --------------------------------------------------------------
// Epics → stories → tasks in one id space. See BacklogItem.cs for the record
// shape and skills/backlog/SKILL.md for the workflow it serves.

app.MapGet("/api/backlog", () =>
    Results.Json(new { ok = true, items = BacklogSummaries(backlogDir) }, json));

app.MapGet("/api/backlog/meta", () =>
{
    var all = LoadBacklog(backlogDir);
    var phases = all.ToDictionary(i => i.Id, i => EffectivePhase(all, i));
    return Results.Json(new
    {
        ok = true,
        count = all.Count,
        byStatus = all.GroupBy(i => i.Status).ToDictionary(g => g.Key, g => g.Count()),
        byType = all.GroupBy(i => i.Type).ToDictionary(g => g.Key, g => g.Count()),
        byAssignee = all.Where(i => i.Assignee.Length > 0).GroupBy(i => i.Assignee).ToDictionary(g => g.Key, g => g.Count()),
        // Phases are the milestone axis the backlog page groups by, so the UI
        // needs the vocabulary even for phases whose epics are all done.
        phases = all.Select(i => phases[i.Id]).Where(p => p.Length > 0).Distinct().OrderBy(p => p).ToList(),
        // The lifecycle table, so the UI renders chevrons and transition
        // buttons from the server's definition instead of a second copy that
        // gets to disagree about which types skip `review`.
        ladders = BacklogItem.Ladders,
        statuses = BacklogItem.Statuses,
        types = BacklogItem.Prefixes.Keys.ToList(),
        byPhase = all.Where(i => phases[i.Id].Length > 0).GroupBy(i => phases[i.Id]).ToDictionary(g => g.Key, g => g.Count()),
    }, json);
});

app.MapGet("/api/backlog/{id:int}", (int id) =>
{
    var all = LoadBacklog(backlogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    return Results.Json(new { ok = true, item = FullItem(all, item) }, json);
});

app.MapPost("/api/backlog", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    string Get(string k, string def = "") =>
        body.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : def;
    List<string> GetList(string k) =>
        body.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).ToList()
            : new();

    var title = Get("title").Trim();
    if (title.Length == 0)
        return Results.Json(new { ok = false, error = "title required" }, json, statusCode: 400);

    var type = Get("type", "story").ToLowerInvariant();
    if (!BacklogItem.Prefixes.ContainsKey(type))
        return Results.Json(new { ok = false, error = $"type must be one of {string.Join(", ", BacklogItem.Prefixes.Keys)}" }, json, statusCode: 400);

    var all = LoadBacklog(backlogDir);
    var parent = body.TryGetValue("parent", out var pv)
        ? (pv.ValueKind == JsonValueKind.Number ? pv.GetInt32() : BacklogItem.ParseRef(pv.GetString()))
        : 0;
    // A parent that does not exist would produce an item that renders nowhere in
    // the tree, so it is rejected rather than stored and quietly orphaned.
    if (parent > 0 && all.All(i => i.Id != parent))
        return Results.Json(new { ok = false, error = $"no backlog item #{parent} to parent this to" }, json, statusCode: 400);

    var status = Get("status", "draft");
    if (!BacklogItem.StatusAllowed(type, status))
        return Results.Json(new { ok = false, error = $"{Article(type)} {type} cannot be '{status}' — its lifecycle is {string.Join(" → ", BacklogItem.LadderFor(type))}" }, json, statusCode: 400);

    var item = new BacklogItem
    {
        Id = all.Select(i => i.Id).DefaultIfEmpty(0).Max() + 1,
        Type = type,
        Title = title,
        Status = status,
        Parent = parent,
        Phase = Get("phase"),
        Assignee = Get("assignee"),
        Points = Get("points"),
        Subsystem = Get("subsystem", "unsorted"),
        Labels = GetList("labels"),
        Links = GetList("links"),
        Created = Md.Today(),
        Updated = Md.Today(),
        Description = Get("description"),
        Acceptance = Get("acceptance"),
    };
    await File.WriteAllTextAsync(Path.Combine(backlogDir, item.FileName), item.Render());

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == item.Id)) }, json);
});

app.MapPost("/api/backlog/{id:int}", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(backlogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(backlogDir, item.FileName);

    var patch = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var text = await File.ReadAllTextAsync(path);
    string? retype = null;      // set when the patch changes the item's type
    string? newStatus = null;   // set when the patch changes the status

    foreach (var (k, v) in patch)
    {
        var key = k.ToLowerInvariant();
        var str = v.ValueKind == JsonValueKind.String ? v.GetString()! : v.ToString();
        switch (key)
        {
            case "status":
            {
                // Against the type this patch LEAVES the item with, not the one
                // it had: a single request may legitimately carry both
                // `{type: task, status: in-progress}`.
                var forType = retype ?? item.Type;
                if (!BacklogItem.StatusAllowed(forType, str))
                    return Results.Json(new { ok = false, error = $"{Article(forType)} {forType} cannot be '{str}' — its lifecycle is {string.Join(" → ", BacklogItem.LadderFor(forType))}" }, json, statusCode: 400);
                text = Md.SetFrontmatter(text, "status", str);
                newStatus = str;
                break;
            }
            case "phase" or "assignee" or "points" or "subsystem" or "title":
                text = Md.SetFrontmatter(text, key, key == "title" ? $"\"{Md.Quote(str)}\"" : str);
                break;
            case "type":
            {
                // The FILE NAME carries the type (BacklogItem.Parse trusts it over
                // the frontmatter, so the same record can never answer to two
                // types). Writing `type:` alone would therefore be a no-op that
                // looks like it worked: the field changes on disk and the parse
                // puts it straight back. Rename the file too, below.
                var next = str.Trim().ToLowerInvariant();
                if (!BacklogItem.Prefixes.ContainsKey(next))
                    return Results.Json(new { ok = false, error = $"type must be one of {string.Join(", ", BacklogItem.Prefixes.Keys)}" }, json, statusCode: 400);
                text = Md.SetFrontmatter(text, "type", next);
                retype = next;
                break;
            }
            case "parent":
            {
                var target = v.ValueKind == JsonValueKind.Number ? v.GetInt32() : BacklogItem.ParseRef(str);
                if (target == id)
                    return Results.Json(new { ok = false, error = "an item cannot be its own parent" }, json, statusCode: 400);
                if (target > 0 && all.All(i => i.Id != target))
                    return Results.Json(new { ok = false, error = $"no backlog item #{target}" }, json, statusCode: 400);
                // Walking UP from the proposed parent is what catches a cycle:
                // re-parenting an epic under its own grandchild is otherwise a
                // perfectly valid-looking single edit that makes the tree
                // unrenderable and the "all descendants" walk non-terminating.
                if (target > 0 && Ancestors(all, target).Contains(id))
                    return Results.Json(new { ok = false, error = $"#{target} is already below #{id} — that would make a cycle" }, json, statusCode: 400);
                text = Md.SetFrontmatter(text, "parent", target > 0 ? target.ToString() : "");
                break;
            }
            case "labels" or "links" when v.ValueKind == JsonValueKind.Array:
                text = Md.SetFrontmatter(text, key, Md.ListValue(v.EnumerateArray().Select(e => e.GetString() ?? "")));
                break;
            case "description":
                text = Md.SetSection(text, "## Description", str);
                break;
            // Refinement is mostly the act of writing these, so they are
            // patchable from the UI the way frontmatter is.
            case "acceptance":
                text = Md.SetSection(text, "## Acceptance criteria", str);
                break;
        }
    }

    // A retype can strand the item on a status its new ladder does not have —
    // a story in `review` demoted to a task. Clamp AFTER the loop: JSON object
    // keys have no order, so "did the status also change" is only answerable
    // once every key has been applied.
    if (retype is not null && retype != item.Type)
    {
        var effective = newStatus ?? item.Status;
        var clamped = BacklogItem.ClampStatus(retype, effective);
        if (clamped != effective) text = Md.SetFrontmatter(text, "status", clamped);
    }

    text = Md.SetFrontmatter(text, "updated", Md.Today());

    if (retype is not null && retype != item.Type)
    {
        // Write the NEW file first, then drop the old one: an interruption
        // between the two leaves the record duplicated (visible, fixable by
        // hand) rather than deleted (gone).
        var next = Path.Combine(backlogDir, $"{BacklogItem.Prefixes[retype]}-{id:D4}.md");
        await File.WriteAllTextAsync(next, text);
        File.Delete(path);
    }
    else
    {
        await File.WriteAllTextAsync(path, text);
    }

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// Acceptance criteria as a real checklist. One line at a time, addressed by
// its position among the section's checkboxes, so ticking a box rewrites that
// box and nothing else — the section is hand-authored markdown and may carry
// context the UI never parsed.
app.MapPost("/api/backlog/{id:int}/criteria", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(backlogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(backlogDir, item.FileName);

    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var op = body.TryGetValue("op", out var o) ? (o.GetString() ?? "").ToLowerInvariant() : "";
    var index = body.TryGetValue("index", out var ix) && ix.ValueKind == JsonValueKind.Number ? ix.GetInt32() : -1;
    var value = body.TryGetValue("value", out var v)
        ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ToString())
        : "";

    if (op is not ("toggle" or "edit" or "remove" or "add"))
        return Results.Json(new { ok = false, error = "op must be toggle, edit, remove or add" }, json, statusCode: 400);
    if (op is "add" or "edit" && value.Trim().Length == 0)
        return Results.Json(new { ok = false, error = "a criterion needs some text" }, json, statusCode: 400);

    var text = await File.ReadAllTextAsync(path);
    // The section is created on demand: an item that has never been refined has
    // no "## Acceptance criteria" heading, and adding the first criterion is
    // exactly how it acquires one.
    if (op == "add" && !text.Contains("## Acceptance criteria", StringComparison.OrdinalIgnoreCase))
        text = Md.SetSection(text, "## Acceptance criteria", "");

    var next = Md.EditChecklist(text, "## Acceptance criteria", op, index, value);
    if (next is null)
        return Results.Json(new { ok = false, error = $"no criterion at position {index}" }, json, statusCode: 400);

    await File.WriteAllTextAsync(path, Md.SetFrontmatter(next, "updated", Md.Today()));

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

app.MapPost("/api/backlog/{id:int}/comments", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(backlogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(backlogDir, item.FileName);

    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var author = body.TryGetValue("author", out var a) ? a.GetString() : users.HumanAuthor;
    var comment = body.TryGetValue("body", out var b) ? b.GetString() : "";
    if (string.IsNullOrWhiteSpace(comment)) return Results.Json(new { ok = false, error = "empty comment" }, json, statusCode: 400);

    await File.WriteAllTextAsync(path, Md.AppendComment(await File.ReadAllTextAsync(path), author ?? users.HumanAuthor, comment!));

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// ---- Identity -------------------------------------------------------------
// The client fetches this once, before it renders anything, so every "who is
// posting this comment" / "on me" / "on the agent" default reflects the
// configured names instead of a hardcoded pair. `configured: false` is what
// triggers the first-run name prompt. See ui/index.html.
app.MapGet("/api/config", () => Results.Json(new
{
    ok = true,
    humanAuthor = users.HumanAuthor,
    agentAuthor = users.AgentAuthor,
    configured = users.Configured,
    envLocked = users.EnvLocked,
    user = users.ActiveSlug,
    profiles = users.Profiles(),
    configDir = users.ConfigDir,
    collaborators = project.Collaborators(),
    assignees = project.Assignees(),
}, json));

// First run (or "switch user"): adopt a profile by name, creating it if needed.
// Writing the profile is what makes `configured` true on the next boot.
app.MapPost("/api/config/user", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var name = body.TryGetValue("name", out var n) ? (n.GetString() ?? "").Trim() : "";
    if (name.Length == 0)
        return Results.Json(new { ok = false, error = "name required" }, json, statusCode: 400);
    if (name.Length > 60)
        return Results.Json(new { ok = false, error = "name must be 60 characters or fewer" }, json, statusCode: 400);

    var agent = body.TryGetValue("agentName", out var a) ? a.GetString() : null;
    // An unnamed agent is DERIVED, not left generic: every person's assistant
    // needs a distinguishable name or two people's agents sign the same way.
    if (string.IsNullOrWhiteSpace(agent)) agent = ProjectConfig.AgentNameFor(name);
    var slug = users.SelectOrCreate(name, agent);
    users.MigrateLegacyFilters(legacyFiltersPath);
    project.Upsert(name, agent);
    app.Logger.LogInformation("BugDesk: user profile {slug} selected", slug);

    return Results.Json(new
    {
        ok = true,
        humanAuthor = users.HumanAuthor,
        agentAuthor = users.AgentAuthor,
        configured = users.Configured,
        envLocked = users.EnvLocked,
        user = slug,
        profiles = users.Profiles(),
        configDir = users.ConfigDir,
        collaborators = project.Collaborators(),
        assignees = project.Assignees(),
    }, json);
});

// ---- The shared roster -----------------------------------------------------
// Managed from Settings, and by the /bugs and /backlog skills, which can add
// the people they find in the git history.
app.MapGet("/api/project", () => Results.Json(new
{
    ok = true,
    path = project.Path,
    config = project.Document(),
    assignees = project.Assignees(),
}, json));

app.MapPost("/api/project/collaborators", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    if (!body.TryGetValue("collaborators", out var list) || list.ValueKind != JsonValueKind.Array)
        return Results.Json(new { ok = false, error = "collaborators array required" }, json, statusCode: 400);
    var saved = project.SetCollaborators(JsonNode.Parse(list.GetRawText())!.AsArray());
    return Results.Json(new { ok = true, collaborators = saved, assignees = project.Assignees() }, json);
});

// Add or update ONE person without having to send the whole roster — what an
// agent does when it notices a name that is not on the list yet.
app.MapPost("/api/project/collaborator", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var name = body.TryGetValue("name", out var n) ? (n.GetString() ?? "").Trim() : "";
    if (name.Length == 0)
        return Results.Json(new { ok = false, error = "name required" }, json, statusCode: 400);
    var agent = body.TryGetValue("agent", out var a) ? a.GetString() : null;
    var saved = project.Upsert(name, agent);
    return Results.Json(new { ok = true, collaborator = saved, assignees = project.Assignees() }, json);
});

// The UI's own preference bag, stored in the profile so it follows the person
// rather than the browser (localStorage does not survive a different machine,
// and BugDesk is a tool you run from wherever the repo is checked out).
app.MapGet("/api/user/settings", () =>
    Results.Json(new { ok = true, settings = users.Settings() }, json));

app.MapPost("/api/user/settings", async (HttpRequest req) =>
{
    if (JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync()) is not JsonObject patch)
        return Results.Json(new { ok = false, error = "expected a JSON object of settings" }, json, statusCode: 400);
    users.MergeSettings(patch);
    return Results.Json(new { ok = true, settings = users.Settings() }, json);
});

// ---- Custom queue filters -------------------------------------------------
// The UI authors filter expressions (an AST); the bridge only stores the JSON
// array verbatim — their shape is the UI's business, so nothing here parses it.
// POST is a FULL REPLACE of the list, which is what the UI's store does anyway.
//
// Filters are PER USER: they live in the profile, not in a shared file. Two
// people on the same repo have different questions to ask of the same bugs.
// A pre-profile server/state/filters.json is folded into the profile once (see
// MigrateLegacyFilters) rather than being abandoned on disk.
app.MapGet("/api/filters", () => Results.Json(new { ok = true, filters = users.Filters() }, json));

app.MapPost("/api/filters", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    if (!body.TryGetValue("filters", out var list) || list.ValueKind != JsonValueKind.Array)
        return Results.Json(new { ok = false, error = "filters array required" }, json, statusCode: 400);
    if (users.ActiveSlug is null)
        return Results.Json(new { ok = false, error = "no user profile yet — set a name first" }, json, statusCode: 409);
    users.SetFilters(JsonNode.Parse(list.GetRawText())!.AsArray());
    return Results.Json(new { ok = true, filters = users.Filters() }, json);
});

// ---- Workspace layout -----------------------------------------------------
// @flexdesk/host's state capability calls these two by name (see
// createPywebviewHost in the FlexDesk package). They used to fall through to the
// permissive catch-all below, which answered {ok:true} to a READ — so the WM
// received the object `{ok:true}` where a saved layout should have been and
// every tile arrangement was lost on reload. They are per-user, like the filters.
app.MapPost("/api/workspace_state_read", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var path = body.TryGetValue("path", out var p) ? p.GetString() ?? "" : "";
    return Results.Json(new { ok = true, result = users.ReadState(path) }, json);
});

app.MapPost("/api/workspace_state_write", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var path = body.TryGetValue("path", out var p) ? p.GetString() ?? "" : "";
    var data = body.TryGetValue("data", out var d) ? d.GetString() ?? "" : "";
    var wrote = users.WriteState(path, data);
    return Results.Json(new { ok = true, result = new { ok = wrote } }, json);
});

// Permissive fallback for the EcoAgent/FlexDesk shell's bridge calls (app_version,
// app_get_platform, ...): anything not handled above returns
// {ok:true, result:{ok:true}} so the shell boots and renders its empty states,
// exactly as ticketdesk's Python bridge did. Specific /api routes above take
// precedence over this catch-all.
app.MapMethods("/api/{**rest}", new[] { "GET", "POST" },
    () => Results.Json(new { ok = true, result = new { ok = true } }, json));

app.Run();

// ---- store resolution -----------------------------------------------------
static string ResolveBugsDir(string contentRoot)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_BUGS");
    if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
    // Self-contained default: a top-level bugs/ directory alongside server/ and
    // ui/. Created on first run (see attachDir above, whose CreateDirectory
    // call also creates this whole parent chain). Point BUGDESK_BUGS elsewhere
    // — e.g. a bugs/ folder tracked inside your own project's repo — to use a
    // different store.
    return Path.GetFullPath(Path.Combine(contentRoot, "..", "bugs"));
}

// The backlog store sits BESIDE the bug store rather than under a path of its
// own: pointing BUGDESK_BUGS at a project brings that project's backlog with it,
// which is almost always what you want. BUGDESK_BACKLOG overrides for the rest.
static string ResolveBacklogDir(string bugsDir)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_BACKLOG");
    var dir = !string.IsNullOrEmpty(env)
        ? Path.GetFullPath(env)
        : Path.GetFullPath(Path.Combine(bugsDir, "..", "backlog"));
    Directory.CreateDirectory(dir);
    return dir;
}

// The shared roster, beside the stores and COMMITTED. See ProjectConfig.cs.
static string ResolveProjectConfig(string bugsDir)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_PROJECT");
    return !string.IsNullOrEmpty(env)
        ? Path.GetFullPath(env)
        : Path.GetFullPath(Path.Combine(bugsDir, "..", "bugdesk.json"));
}

// Per-user config, beside the stores. See UserConfig.cs.
static string ResolveConfigDir(string bugsDir)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_CONFIG");
    return !string.IsNullOrEmpty(env)
        ? Path.GetFullPath(env)
        : Path.GetFullPath(Path.Combine(bugsDir, "..", ".bugdesk"));
}

// Legacy, pre-profile UI state (the shared filters.json). Nothing is written
// here any more; it is read once so an upgrade does not lose saved filters.
static string ResolveStateDir(string contentRoot)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_STATE");
    if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
    return Path.GetFullPath(Path.Combine(contentRoot, "state"));
}

// ---- helpers --------------------------------------------------------------

// Allow-list of image types, mapped to the extension we store them under. The
// declared content type wins; the original filename is only a fallback for
// drops that arrive without one. Anything else is rejected rather than saved
// under a guessed extension — this is what keeps /attachments an image dir.
static string? ExtensionForImage(string contentType, string? name)
{
    var ext = (contentType ?? "").Trim().ToLowerInvariant() switch
    {
        "image/png" => ".png",
        "image/jpeg" or "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/avif" => ".avif",
        _ => null,
    };
    if (ext is not null) return ext;
    var fromName = Path.GetExtension(name ?? "").ToLowerInvariant();
    return fromName is ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".svg" or ".avif"
        ? (fromName == ".jpeg" ? ".jpg" : fromName)
        : null;
}

static string BugPath(string dir, int id) => Path.Combine(dir, $"BUG-{id:D4}.md");

/// "an epic", "a story". These messages are read by people on every rejected
/// edit, and "a epic" reads as a bug in the tool.
static string Article(string word) =>
    word.Length > 0 && "aeiou".Contains(char.ToLowerInvariant(word[0])) ? "an" : "a";

static List<Bug> LoadAll(string dir) =>
    Directory.Exists(dir)
        ? Directory.EnumerateFiles(dir, "BUG-*.md").Select(Bug.Parse).Where(b => b != null).Select(b => b!).ToList()
        : new();

static Bug? LoadOne(string dir, int id)
{
    var p = BugPath(dir, id);
    return File.Exists(p) ? Bug.Parse(p) : null;
}

static List<BacklogItem> LoadBacklog(string dir)
{
    if (!Directory.Exists(dir)) return new();
    var items = new List<BacklogItem>();
    foreach (var prefix in BacklogItem.Prefixes.Values)
        foreach (var path in Directory.EnumerateFiles(dir, $"{prefix}-*.md"))
            if (BacklogItem.Parse(path) is { } item) items.Add(item);
    return items;
}

/// Ids from `id` up to the root, exclusive of `id` itself.
static List<int> Ancestors(List<BacklogItem> all, int id)
{
    var chain = new List<int>();
    var seen = new HashSet<int> { id };
    var cur = all.FirstOrDefault(i => i.Id == id)?.Parent ?? 0;
    while (cur > 0 && seen.Add(cur))
    {
        chain.Add(cur);
        cur = all.FirstOrDefault(i => i.Id == cur)?.Parent ?? 0;
    }
    return chain;
}

/// The item's own phase, or the nearest ancestor's. Epics carry the label;
/// stories and tasks inherit it, so "what is left in phase X" is answerable
/// without stamping the same string onto every descendant.
static string EffectivePhase(List<BacklogItem> all, BacklogItem item)
{
    if (item.Phase.Length > 0) return item.Phase;
    foreach (var id in Ancestors(all, item.Id))
    {
        var anc = all.FirstOrDefault(i => i.Id == id);
        if (anc is { Phase.Length: > 0 }) return anc.Phase;
    }
    return "";
}

/// Summaries in TREE ORDER — each epic followed by its stories, each story by
/// its tasks — so the UI can render the hierarchy by indenting a flat list
/// instead of rebuilding the order client-side. Orphans (a parent that was
/// deleted) sort to the end rather than disappearing.
static List<object> BacklogSummaries(string dir)
{
    var all = LoadBacklog(dir);
    var childCount = all.Where(i => i.Parent > 0).GroupBy(i => i.Parent).ToDictionary(g => g.Key, g => g.Count());
    var byParent = all.GroupBy(i => i.Parent).ToDictionary(g => g.Key, g => g.OrderBy(i => i.TypeOrder).ThenBy(i => i.Id).ToList());
    var known = all.Select(i => i.Id).ToHashSet();

    var ordered = new List<BacklogItem>();
    var seen = new HashSet<int>();
    void Walk(int parent)
    {
        if (!byParent.TryGetValue(parent, out var kids)) return;
        foreach (var kid in kids)
        {
            if (!seen.Add(kid.Id)) continue;   // a cycle survived some hand edit
            ordered.Add(kid);
            Walk(kid.Id);
        }
    }
    Walk(0);
    // Anything whose parent id points at a record that no longer exists.
    foreach (var item in all.OrderBy(i => i.TypeOrder).ThenBy(i => i.Id))
        if (!seen.Contains(item.Id) && !known.Contains(item.Parent)) { seen.Add(item.Id); ordered.Add(item); }
    foreach (var item in all.OrderBy(i => i.Id))
        if (seen.Add(item.Id)) ordered.Add(item);

    return ordered.Select(i => i.ToSummary(EffectivePhase(all, i), childCount.GetValueOrDefault(i.Id))).ToList();
}

/// One item with everything the detail page needs: the record, its resolved
/// phase, and enough of its neighbours to render breadcrumbs and a child list
/// without a second round trip.
static object FullItem(List<BacklogItem> all, BacklogItem item)
{
    var childCount = all.Count(i => i.Parent == item.Id);
    return new
    {
        id = item.Id, type = item.Type, title = item.Title, status = item.Status, stage = item.Stage,
        ladder = BacklogItem.LadderFor(item.Type),
        parent = item.Parent, phase = item.Phase, effectivePhase = EffectivePhase(all, item),
        assignee = item.Assignee, points = item.Points, subsystem = item.Subsystem,
        labels = item.Labels, links = item.Links, created = item.Created, updated = item.Updated,
        description = item.Description, acceptance = item.Acceptance, criteria = item.Criteria(),
        comments = item.Comments, children = childCount,
        ancestors = Ancestors(all, item.Id)
            .Select(id => all.First(i => i.Id == id))
            .Select(a => new { id = a.Id, type = a.Type, title = a.Title })
            .Reverse().ToList(),
        childItems = all.Where(i => i.Parent == item.Id)
            .OrderBy(i => i.TypeOrder).ThenBy(i => i.Id)
            .Select(c => new { id = c.Id, type = c.Type, title = c.Title, status = c.Status, points = c.Points, assignee = c.Assignee })
            .ToList(),
    };
}
