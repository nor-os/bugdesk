using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

// BugDesk bridge: serves the FlexDesk UI and exposes directories of markdown
// records as JSON. The markdown files are the source of truth; this process only
// reads and writes them.
//
// WHERE those directories are depends on the MODE — see the block below.

// ---- Mode ------------------------------------------------------------------
// BugDesk runs in one of two modes, chosen at launch and never switched at
// runtime — it decides what the app is FOR, and a toggle inside the UI would
// invite flipping it per tab. Resolved FIRST, because every path below depends
// on it.
//
//   bugs      (default) a bug tracker with a backlog beside it, both inside the
//             project repo, both committed. What BugDesk has always been.
//   tracker   a follow-up tracker: work you have handed to other people. It is
//             NOT about the code in any repo, so it does not live in one — see
//             ResolveTrackerBase. Adds the `project` level above epics, target
//             dates, and the dashboard that answers "what did I assign, and
//             what is late".
string mode = ResolveMode(args);

// Our own flags are stripped before the host sees them: ASP.NET's command-line
// configuration provider wants `--key=value` or `--key value`, and a bare
// `--tracker` makes it throw before a line of this file runs.
var builder = WebApplication.CreateBuilder(HostArgs(args));

// ---- Locate our own assets -------------------------------------------------
// Walked UP from both the content root and the binary, rather than assumed to
// be "one above the working directory". That assumption held only while BugDesk
// was always started by run.sh, which cd's into server/ first. A tracker is
// started from wherever the user happens to be — that directory is what names
// the tracker — so the working directory is no longer a reliable anchor, and
// getting this wrong means silently serving no UI at all.
string uiDir = FindNear(Path.Combine("ui", "index.html"),
                        builder.Environment.ContentRootPath, AppContext.BaseDirectory)
               is { } indexHtml
    ? Path.GetDirectoryName(indexHtml)!
    : Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "ui"));

// ---- Locate the stores ----------------------------------------------------
string trackerBase = mode == "tracker" ? ResolveTrackerBase(args) : "";
string bugsDir = mode == "tracker"
    ? Env("BUGDESK_BUGS") ?? Path.Combine(trackerBase, "bugs")
    : ResolveBugsDir(builder.Environment.ContentRootPath);
string backlogDir = mode == "tracker"
    ? EnsureDir(Env("BUGDESK_BACKLOG") ?? Path.Combine(trackerBase, "tickets"))
    : ResolveBacklogDir(bugsDir);
// Attachments sit beside the records in tracker mode. In bugs mode they stay
// under the bug store, where existing ones already are.
string attachDir = mode == "tracker"
    ? Path.Combine(trackerBase, "attachments")
    : Path.Combine(bugsDir, "attachments");

// ---- Port ------------------------------------------------------------------
// A tracker is a personal tool you open when you want it, often alongside a
// BugDesk already running on a repo — so a fixed port would collide with the
// thing you were already using. Take the next free one instead, and only when
// nothing more specific was asked for: an explicit ASPNETCORE_URLS is a
// deliberate choice and must not be second-guessed.
if (mode == "tracker" && string.IsNullOrEmpty(Env("ASPNETCORE_URLS")))
{
    var port = FirstFreePort(8766);
    if (port > 0) builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
}

var app = builder.Build();

app.Logger.LogInformation("BugDesk: mode={mode} records={records} ui={ui}",
    mode, mode == "tracker" ? backlogDir : $"{bugsDir} + {backlogDir}", uiDir);

// `--seed` for a tracker is applied HERE rather than in run.sh, because run.sh
// does not know where a tracker's records live — the server owns that path, and
// two places computing it is two places to get it wrong. Never overwrites: a
// store with anything in it is left exactly as it is.
if (mode == "tracker" && Env("BUGDESK_SEED_TRACKER") is not null)
{
    var samples = FindNear(Path.Combine("examples", "tracker"),
                           builder.Environment.ContentRootPath, AppContext.BaseDirectory) ?? "";
    var existing = Directory.EnumerateFiles(backlogDir, "*.md").Any();
    if (existing)
        app.Logger.LogInformation("BugDesk: {dir} already has records — skipping --seed", backlogDir);
    else if (samples.Length == 0 || !Directory.Exists(samples))
        app.Logger.LogInformation("BugDesk: no examples at {dir} — nothing to seed", samples);
    else
    {
        var n = 0;
        foreach (var file in Directory.EnumerateFiles(samples, "*.md"))
        {
            File.Copy(file, Path.Combine(backlogDir, Path.GetFileName(file)), overwrite: false);
            n++;
        }
        app.Logger.LogInformation("BugDesk: seeded {dir} with {n} example ticket(s)", backlogDir, n);
    }
}

// ---- Authorship (configurable — see README "Authorship") ------------------
// BugDesk's lifecycle assumes exactly two roles: a human who files/triages/tests
// records through this UI, and an agent who investigates them (typically an AI
// coding assistant driven through the /bugs and /backlog skills). Neither name is
// fixed. The name comes from the per-user PROFILE — what the first-run screen
// and "change your name" write. BUGDESK_HUMAN/BUGDESK_AGENT SEED that profile
// when there is none yet (a scripted deployment, CI); they no longer outrank it,
// because a variable exported in a shell profile used to make every later name
// change a file the server then ignored. BUGDESK_USER is what picks a different
// profile per process, for two people sharing one checkout.
string configDir = mode == "tracker"
    ? Env("BUGDESK_CONFIG") ?? Path.Combine(trackerBase, "config")
    : ResolveConfigDir(bugsDir);
// TRACKER mode assigns work to PEOPLE, so it derives no `<name>_agent` — see
// ProjectConfig.AgentsAssignable.
bool agentsAssignable = mode != "tracker";
var users = new UserStore(
    configDir,
    Environment.GetEnvironmentVariable("BUGDESK_USER"),
    Environment.GetEnvironmentVariable("BUGDESK_HUMAN"),
    Environment.GetEnvironmentVariable("BUGDESK_AGENT"),
    agentsAssignable);
app.Logger.LogInformation("BugDesk: config={config} user={user}",
    users.ConfigDir, users.ActiveSlug ?? "(unconfigured — the UI will ask)");

// The SHARED roster — who works on this repo. Committed, unlike the per-user
// profile: an assignee dropdown offering only "me and my agent" is useless the
// moment a record belongs to somebody else.
var project = new ProjectConfig(ResolveProjectConfig(bugsDir, configDir), agentsAssignable);
app.Logger.LogInformation("BugDesk: project={project}", project.Path);

// Pre-profile UI state: a single shared filters.json. Read once, folded into
// whichever profile is active, and never written again. Declared here because
// the first-run handler below migrates on the profile it has just created.
string legacyFiltersPath = Path.Combine(ResolveStateDir(app.Environment.ContentRootPath), "filters.json");
users.MigrateLegacyFilters(legacyFiltersPath);

// ---- Live updates ---------------------------------------------------------
// The markdown files are the source of truth precisely so other things write
// them — a git pull, an agent through the /bugs skill, somebody's editor. The
// watcher turns those into SSE so an open browser is never looking at a store
// that has moved on without it. See StoreWatcher.cs, and note that EVERY write
// below goes through WriteRecord so the watcher can tell our own echo from a
// real change.
var watcher = new StoreWatcher(bugsDir, backlogDir, project.Path, app.Logger);
app.Lifetime.ApplicationStopping.Register(() => watcher.Dispose());

async Task WriteRecord(string path, string text)
{
    await File.WriteAllTextAsync(path, text);
    watcher.Note(path, text);
}

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
    await WriteRecord(path, text);
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
    await WriteRecord(path, text);
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

    await WriteRecord(BugPath(bugsDir, nextId), sb.ToString());
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
        prefixes = BacklogItem.Prefixes,
        // How much of the store has a target date at all. The dashboard leads
        // with the gap rather than the schedule: items nobody has dated are
        // invisible to every "what is due" question asked of them.
        dated = all.Count(i => i.Due.Length > 0),
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

    var due = Get("due");
    if (!BacklogItem.IsValidDate(due))
        return Results.Json(new { ok = false, error = $"due must be YYYY-MM-DD (got '{due}')" }, json, statusCode: 400);

    var item = new BacklogItem
    {
        Id = all.Select(i => i.Id).DefaultIfEmpty(0).Max() + 1,
        Type = type,
        Title = title,
        Status = status,
        Parent = parent,
        Phase = Get("phase"),
        Assignee = Get("assignee"),
        // Who is following this up. Defaults to whoever is running BugDesk —
        // in tracker mode that is the whole point of the record, and asking
        // "who are you filing this as" of a single-operator tool would be a
        // question with one possible answer.
        Reporter = Get("reporter", users.HumanAuthor),
        Due = BacklogItem.NormalizeDate(due),
        Points = Get("points"),
        Subsystem = Get("subsystem", "unsorted"),
        Labels = GetList("labels"),
        Links = GetList("links"),
        Created = Md.Today(),
        Updated = Md.Today(),
        Description = Get("description"),
        Acceptance = Get("acceptance"),
    };
    await WriteRecord(Path.Combine(backlogDir, item.FileName), item.Render());

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
            case "phase" or "assignee" or "reporter" or "points" or "subsystem" or "title":
                text = Md.SetFrontmatter(text, key, key == "title" ? $"\"{Md.Quote(str)}\"" : str);
                break;
            case "due":
            {
                // Rejected rather than silently dropped: a target date the user
                // typed and the tracker quietly discarded is the one edit whose
                // failure they would never notice.
                if (!BacklogItem.IsValidDate(str))
                    return Results.Json(new { ok = false, error = $"due must be YYYY-MM-DD (got '{str}')" }, json, statusCode: 400);
                text = Md.SetFrontmatter(text, "due", BacklogItem.NormalizeDate(str));
                break;
            }
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
        await WriteRecord(next, text);
        File.Delete(path);
    }
    else
    {
        await WriteRecord(path, text);
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

    await WriteRecord(path, Md.SetFrontmatter(next, "updated", Md.Today()));

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// ---- Deleting a record -----------------------------------------------------
// The one destructive operation in the API, and the only one that needs an
// answer about what happens to what was underneath it.
//
// `children=cascade` deletes the whole subtree; `children=promote` keeps the
// descendants and hands them the deleted item's own parent, so the tree closes
// over the gap instead of scattering. Called with neither on an item that HAS
// descendants, it refuses and reports the count — that is a decision the caller
// has to make, and guessing either way loses somebody's work or leaves a mess.
//
// NOTHING IS UNLINKED. The file moves to a `trash/` folder in BugDesk's own
// config directory — never inside the store, which the watcher is pointed at. A bug store
// lives in a git repo and a delete there is one `git checkout` from coming back,
// but a TRACKER's store deliberately lives outside any repo (see
// ResolveTrackerBase), so an unlink there is final — and this is a personal
// follow-up list where a mis-click costs a project with everything under it.
app.MapDelete("/api/backlog/{id:int}", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(backlogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);

    var kids = Descendants(all, id);
    var howChildren = (req.Query["children"].ToString() ?? "").Trim().ToLowerInvariant();
    if (kids.Count > 0 && howChildren is not ("cascade" or "promote"))
    {
        return Results.Json(new
        {
            ok = false,
            error = $"#{id} has {kids.Count} item{(kids.Count == 1 ? "" : "s")} under it — "
                  + "pass children=cascade to delete them too, or children=promote to keep them",
            descendants = kids.Count,
            children = all.Count(i => i.Parent == id),
        }, json, statusCode: 409);
    }

    // BESIDE the store, never inside it: the watcher is pointed at the store
    // directory, so a file moved into a `.trash/` within it reads as a brand-new
    // record — our own delete would announce itself to every open browser as an
    // arrival. It also keeps out of git, in both modes: in a repo the config
    // directory is already self-ignoring, and a tracker is not in a repo at all.
    var trash = Path.Combine(configDir, "trash");
    Directory.CreateDirectory(trash);
    var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");

    var doomed = new List<BacklogItem> { item };
    if (howChildren == "cascade") doomed.AddRange(kids.Select(k => all.First(i => i.Id == k)));

    var promoted = new List<int>();
    if (howChildren == "promote")
    {
        // Direct children only: everything deeper keeps the parent it has, and
        // the subtree travels with the child rather than being flattened.
        foreach (var child in all.Where(i => i.Parent == id))
        {
            var path = Path.Combine(backlogDir, child.FileName);
            var text = Md.SetFrontmatter(await File.ReadAllTextAsync(path), "parent",
                item.Parent > 0 ? item.Parent.ToString() : "");
            await WriteRecord(path, Md.SetFrontmatter(text, "updated", Md.Today()));
            promoted.Add(child.Id);
        }
    }

    foreach (var doom in doomed)
    {
        var from = Path.Combine(backlogDir, doom.FileName);
        if (!File.Exists(from)) continue;
        watcher.NoteDeletion(from);
        File.Move(from, Path.Combine(trash, $"{stamp}-{doom.FileName}"), overwrite: true);
    }

    app.Logger.LogInformation("BugDesk: deleted {n} record(s) to {trash}", doomed.Count, trash);
    return Results.Json(new
    {
        ok = true,
        deleted = doomed.Select(d => d.Id).ToList(),
        promoted,
        trash,
    }, json);
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

    await WriteRecord(path, Md.AppendComment(await File.ReadAllTextAsync(path), author ?? users.HumanAuthor, comment!));

    var reloaded = LoadBacklog(backlogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// ---- Search ----------------------------------------------------------------
// FULLTEXT, across BOTH stores, over what is actually IN the files — the title
// and the reference, yes, but also the description, the acceptance criteria and
// every comment. That is the difference between a search and a title filter:
// the thing you remember about a bug three weeks later is usually a phrase
// somebody wrote in a comment, not its summary line.
//
// Server-side because the browser does not have the bodies. The list endpoints
// return summaries — deliberately, they feed tables — so a client-side search
// can only ever match the columns. Here the records are already parsed.
//
// Small-store assumptions, stated so nobody is surprised later: every record is
// read and scanned on every query. A store is a few hundred markdown files a
// human triages by hand; when that stops being true this wants an index, and
// the endpoint is the place to put one.
app.MapGet("/api/search", (string? q, int? limit) =>
{
    var terms = (q ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(t => t.ToLowerInvariant()).ToArray();
    if (terms.Length == 0)
        return Results.Json(new { ok = true, query = q ?? "", count = 0, results = Array.Empty<object>() }, json);

    var take = Math.Clamp(limit ?? 40, 1, 200);
    var hits = new List<SearchHit>();

    foreach (var bug in LoadAll(bugsDir))
    {
        var doc = new SearchDoc(
            Store: "bugs", Id: bug.Id, Ref: $"BUG-{bug.Id:D4}", Type: bug.Type,
            Title: bug.Title, Status: bug.Status, Assignee: bug.Assignee, Updated: bug.Updated,
            Description: bug.Description,
            Extra: string.Join(' ', bug.Labels.Concat(new[] { bug.Subsystem, bug.Severity })),
            Comments: bug.Comments);
        if (Match(doc, terms) is { } hit) hits.Add(hit);
    }

    var all = LoadBacklog(backlogDir);
    foreach (var item in all)
    {
        var doc = new SearchDoc(
            Store: "backlog", Id: item.Id, Ref: $"{BacklogItem.Prefixes.GetValueOrDefault(item.Type, "TASK")}-{item.Id:D4}",
            Type: item.Type, Title: item.Title, Status: item.Status, Assignee: item.Assignee,
            Updated: item.Updated, Description: item.Description,
            Extra: string.Join(' ', item.Labels.Concat(new[] { item.Subsystem, item.Phase, item.Points, item.Acceptance })),
            Comments: item.Comments);
        if (Match(doc, terms) is { } hit) hits.Add(hit);
    }

    // Best field first, then most recently touched — what you were working on
    // is what you are most likely looking for.
    var results = hits
        .OrderBy(h => h.Rank)
        .ThenByDescending(h => h.Doc.Updated, StringComparer.Ordinal)
        .Take(take)
        .Select(h => new
        {
            store = h.Doc.Store, id = h.Doc.Id, @ref = h.Doc.Ref, type = h.Doc.Type,
            title = h.Doc.Title, status = h.Doc.Status, assignee = h.Doc.Assignee,
            updated = h.Doc.Updated, where = h.Where, snippet = h.Snippet,
        })
        .ToList();

    return Results.Json(new { ok = true, query = q, count = hits.Count, results }, json);
});

// ---- Identity -------------------------------------------------------------
// The client fetches this once, before it renders anything, so every "who is
// posting this comment" / "on me" / "on the agent" default reflects the
// configured names instead of a hardcoded pair. `configured: false` is what
// triggers the first-run name prompt. See ui/index.html.
app.MapGet("/api/config", () => Results.Json(new
{
    ok = true,
    // Which app this is. The UI reads it before it evaluates a single page
    // module (see ui/index.html) because the taxonomy — which top-nav chips
    // exist, and what they are called — is built at module load.
    mode,
    // Whether `<name>_agent` is a thing you can assign work to here.
    agentsAssignable,
    humanAuthor = users.HumanAuthor,
    agentAuthor = users.AgentAuthor,
    configured = users.Configured,
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
    // Except in TRACKER mode, where nobody in the store has an assistant and a
    // `<name>_agent` beside every person is an entry no picker can use.
    if (string.IsNullOrWhiteSpace(agent) && agentsAssignable) agent = ProjectConfig.AgentNameFor(name);
    var slug = users.SelectOrCreate(name, agent);
    users.MigrateLegacyFilters(legacyFiltersPath);
    project.Upsert(name, agent);
    app.Logger.LogInformation("BugDesk: user profile {slug} selected", slug);

    return Results.Json(new
    {
        ok = true,
        mode,
        humanAuthor = users.HumanAuthor,
        agentAuthor = users.AgentAuthor,
        configured = users.Configured,
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

// ---- Live updates: the stream ---------------------------------------------
// One long-lived response per open browser. Registered BEFORE the catch-all,
// which would otherwise answer it with a JSON object and no stream at all.
app.MapGet("/api/events", async (HttpContext http, CancellationToken ct) =>
{
    http.Response.Headers.ContentType = "text/event-stream";
    http.Response.Headers.CacheControl = "no-cache, no-transform";
    // Tells nginx and friends not to buffer; without it the stream is invisible
    // behind a reverse proxy until something flushes a whole buffer's worth.
    http.Response.Headers["X-Accel-Buffering"] = "no";

    var channel = watcher.Subscribe();
    var write = async (string frame) =>
    {
        await http.Response.WriteAsync(frame, ct);
        await http.Response.Body.FlushAsync(ct);
    };

    try
    {
        await write(": connected\n\n");
        while (!ct.IsCancellationRequested)
        {
            // Race the next event against the heartbeat: an idle stream that
            // never writes is dropped by proxies and by some browsers, and the
            // client cannot tell that from "nothing has changed".
            var next = channel.Reader.WaitToReadAsync(ct).AsTask();
            var tick = Task.Delay(StoreWatcher.Heartbeat, ct);
            var done = await Task.WhenAny(next, tick);
            if (done == tick) { await write(": ping\n\n"); continue; }
            if (!await next) break;
            while (channel.Reader.TryRead(out var frame)) await write(frame);
        }
    }
    catch (OperationCanceledException) { /* the browser went away */ }
    catch (IOException) { /* the browser went away mid-write */ }
    finally { watcher.Unsubscribe(channel); }
});

// Permissive fallback for the EcoAgent/FlexDesk shell's bridge calls (app_version,
// app_get_platform, ...): anything not handled above returns
// {ok:true, result:{ok:true}} so the shell boots and renders its empty states,
// exactly as ticketdesk's Python bridge did. Specific /api routes above take
// precedence over this catch-all.
app.MapMethods("/api/{**rest}", new[] { "GET", "POST" },
    () => Results.Json(new { ok = true, result = new { ok = true } }, json));

app.Run();

// ---- launch plumbing -------------------------------------------------------

/// A non-empty environment variable, or null. Saves repeating the emptiness
/// check at every call site where "" and "unset" must mean the same thing.
static string? Env(string name)
{
    var v = Environment.GetEnvironmentVariable(name);
    return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
}

/// <summary>
/// The first existing <paramref name="marker"/> found by walking UP from each
/// of <paramref name="starts"/>. Returns its full path, or null.
/// <para>
/// The marker is a RELATIVE path with a file at the end of it
/// (<c>ui/index.html</c>, not <c>ui</c>) so a stray directory of the same name
/// somewhere up the tree cannot be mistaken for the real one.
/// </para>
/// </summary>
static string? FindNear(string marker, params string?[] starts)
{
    foreach (var start in starts)
    {
        if (string.IsNullOrWhiteSpace(start)) continue;
        var dir = new DirectoryInfo(Path.GetFullPath(start));
        for (var hops = 0; dir is not null && hops < 8; hops++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, marker);
            if (File.Exists(candidate) || Directory.Exists(candidate)) return candidate;
        }
    }
    return null;
}

static string EnsureDir(string path)
{
    var full = Path.GetFullPath(path);
    Directory.CreateDirectory(full);
    return full;
}

/// BugDesk's own flags, removed before the generic host parses the rest.
static string[] HostArgs(string[] argv) => argv.Where(a =>
    a is not ("--tracker" or "--bugs")
    && !a.StartsWith("--mode=", StringComparison.OrdinalIgnoreCase)
    && !a.StartsWith("--project=", StringComparison.OrdinalIgnoreCase)).ToArray();

/// The first free loopback port at or after <paramref name="start"/>, or 0 if
/// the whole window is taken.
///
/// <para>
/// Bind-and-release, not a scan of what is listening: only an actual bind
/// proves the port is usable by THIS process. There is a race between releasing
/// it and Kestrel taking it, and it is the right trade for a local single-user
/// tool — the alternative is handing Kestrel a socket, which means reimplementing
/// its listener configuration to save a window measured in milliseconds.
/// </para>
static int FirstFreePort(int start, int window = 200)
{
    for (var port = start; port < start + window && port < 65536; port++)
    {
        try
        {
            var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
            return port;
        }
        catch (System.Net.Sockets.SocketException) { /* in use — try the next */ }
    }
    return 0;
}

// ---- tracker storage -------------------------------------------------------

/// <summary>
/// Where a TRACKER's records live: <c>&lt;root&gt;/&lt;project&gt;</c>.
///
/// <para>
/// NOT in a repo, and that is the whole point. A tracker is a manager's record
/// of work handed to other people; it is not about the code in any checkout,
/// most of the people in it have never seen that checkout, and committing it
/// would put private notes about colleagues into a shared history. So it lives
/// under the user's own BugDesk directory — <c>%APPDATA%\BugDesk</c> on Windows,
/// <c>~/.bugdesk</c> everywhere else — with one folder per project, so one
/// person can keep several trackers apart.
/// </para>
///
/// <code>
/// ~/.bugdesk/
///   acme-migration/
///     tickets/      PROJ-/EPIC-/STORY-/TASK-NNNN.md
///     attachments/
///     config/       who you are, the roster, your layout
/// </code>
///
/// <para>
/// The record directory is <c>tickets/</c>, not <c>backlog/</c>: the top bar
/// says Tickets in this mode, and a backlog is work you plan for yourself
/// rather than a list of things other people owe you. There is no
/// <c>bugs/</c> — a tracker has no bug store, and the UI drops the chip that
/// would lead to one.
/// </para>
///
/// <para>
/// The project name comes from <c>--project</c>, then
/// <c>BUGDESK_TRACKER_PROJECT</c>, then the directory BugDesk was STARTED in
/// (run.sh exports it before it cd's into server/), then "default". Starting a
/// tracker from a directory and getting that directory's tracker is the
/// behaviour worth having; naming it explicitly is for when it is not.
/// </para>
/// </summary>
static string ResolveTrackerBase(string[] argv)
{
    var root = Env("BUGDESK_TRACKER_HOME");
    if (root is null)
    {
        if (OperatingSystem.IsWindows())
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            root = string.IsNullOrEmpty(appData) ? null : Path.Combine(appData, "BugDesk");
        }
        root ??= Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bugdesk");
    }
    return EnsureDir(Path.Combine(Path.GetFullPath(root), ResolveTrackerProject(argv)));
}

static string ResolveTrackerProject(string[] argv)
{
    string? name = null;
    for (var i = 0; i < argv.Length; i++)
    {
        if (argv[i].StartsWith("--project=", StringComparison.OrdinalIgnoreCase))
            name = argv[i]["--project=".Length..];
        else if (argv[i] is "--project" && i + 1 < argv.Length)
            name = argv[i + 1];
    }
    name ??= Env("BUGDESK_TRACKER_PROJECT")
          ?? Path.GetFileName((Env("BUGDESK_INVOKED_FROM") ?? Directory.GetCurrentDirectory())
                              .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
    // Slugged with the same rule profiles use, so a project called "ACME / Q4"
    // cannot escape the tracker root or collide with "acme-q4".
    return UserStore.SlugOf(name ?? "default");
}

// ---- mode -----------------------------------------------------------------
// `--tracker` on the command line, or BUGDESK_MODE=tracker. The flag wins: it
// is the more local statement of intent, and run.sh forwards it verbatim.
// Anything unrecognised is "bugs" rather than an error — a typo should start
// the app you already had, not refuse to start at all.
static string ResolveMode(string[] argv)
{
    foreach (var a in argv)
    {
        if (a is "--tracker") return "tracker";
        if (a is "--bugs") return "bugs";
        if (a.StartsWith("--mode=", StringComparison.OrdinalIgnoreCase))
            return a[7..].Trim().ToLowerInvariant() == "tracker" ? "tracker" : "bugs";
    }
    var env = (Environment.GetEnvironmentVariable("BUGDESK_MODE") ?? "").Trim().ToLowerInvariant();
    return env == "tracker" ? "tracker" : "bugs";
}

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

// The shared roster — COMMITTED, unlike everything else in the config dir. See
// ProjectConfig.cs.
//
// It lives at `.bugdesk/project.json`, in the same directory as the per-user
// files, because a `bugdesk.json` at the project root sitting next to a
// `.bugdesk/` directory reads as two names for one thing rather than as "the
// team's" and "yours". The difference is real, and the place it actually has an
// effect is git — so that is where it is now stated: `.bugdesk/.gitignore`
// ignores everything in there EXCEPT this file (see UserStore.EnsureGitIgnore).
//
// A ROOT bugdesk.json still wins when one exists. Repos created before the move
// have it committed and referenced in their history; silently reading a
// different, empty file would look exactly like BugDesk losing the roster, and
// moving a tracked file out from under someone mid-session is worse. It is a
// `git mv` whenever they want it, and nothing breaks if they never do.
static string ResolveProjectConfig(string bugsDir, string configDir)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_PROJECT");
    if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);

    var legacy = Path.GetFullPath(Path.Combine(bugsDir, "..", "bugdesk.json"));
    if (File.Exists(legacy)) return legacy;

    return Path.GetFullPath(Path.Combine(configDir, UserStore.SharedFileName));
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

// ---- search helpers ---------------------------------------------------------

/// <summary>
/// Does this record match EVERY term, and if so, where best?
///
/// <para>
/// Every term must appear somewhere (AND), because two words are how a person
/// narrows a search — "sso revoke" should not return everything about SSO. But
/// they need not appear in the SAME field: one may be in the title and the
/// other in a comment, and requiring both in one place would rule out most of
/// what a person is actually looking for.
/// </para>
///
/// <para>
/// The RANK is where the FIRST term landed, best field wins: a reference beats
/// a title beats a body beats a comment. That is roughly how specific each is —
/// typing "BUG-0042" means the bug, typing a phrase from a comment means
/// "somewhere in here somebody said this".
/// </para>
/// </summary>
static SearchHit? Match(SearchDoc doc, string[] terms)
{
    var comments = string.Join('\n', doc.Comments.Select(c => $"{c.Author} {c.Body}"));
    var fields = new (int Rank, string Where, string Text)[]
    {
        (0, "reference", doc.Ref),
        (1, "title", doc.Title),
        (2, "description", doc.Description),
        (3, "comment", comments),
        (4, "field", $"{doc.Extra} {doc.Status} {doc.Assignee}"),
    };

    var best = int.MaxValue;
    var where = "field";
    string? snippetSource = null;

    foreach (var term in terms)
    {
        var found = false;
        foreach (var f in fields)
        {
            if (f.Text.Contains(term, StringComparison.OrdinalIgnoreCase))
            {
                found = true;
                if (f.Rank < best) { best = f.Rank; where = f.Where; snippetSource = f.Text; }
                break;
            }
        }
        if (!found) return null;      // AND: one missing term is no match
    }

    return new SearchHit(doc, best, where, Snippet(snippetSource ?? doc.Title, terms[0]));
}

/// <summary>
/// A line of context around the match, so a result says WHY it matched.
/// <para>
/// A list of titles cannot: three bugs about "the importer" look identical, and
/// the one you want is the one whose comment mentions the timeout. The window is
/// widened to whitespace at both ends so it never cuts a word in half.
/// </para>
/// </summary>
static string Snippet(string text, string term, int window = 120)
{
    var flat = text.Replace('\n', ' ').Replace('\r', ' ').Trim();
    while (flat.Contains("  ")) flat = flat.Replace("  ", " ");
    if (flat.Length <= window) return flat;

    var at = flat.IndexOf(term, StringComparison.OrdinalIgnoreCase);
    if (at < 0) return flat[..window].TrimEnd() + "…";

    var start = Math.Max(0, at - window / 3);
    var end = Math.Min(flat.Length, start + window);
    if (start > 0) { var sp = flat.IndexOf(' ', start); if (sp > 0 && sp < at) start = sp + 1; }
    if (end < flat.Length) { var sp = flat.LastIndexOf(' ', end - 1); if (sp > at + term.Length) end = sp; }
    return (start > 0 ? "…" : "") + flat[start..end].Trim() + (end < flat.Length ? "…" : "");
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

/// Every id BELOW `id`, at any depth. The set a cascade deletes, and the set a
/// bare delete refuses to strand.
static List<int> Descendants(List<BacklogItem> all, int id)
{
    var out_ = new List<int>();
    var seen = new HashSet<int> { id };
    var queue = new Queue<int>();
    queue.Enqueue(id);
    while (queue.Count > 0)
    {
        var parent = queue.Dequeue();
        foreach (var child in all.Where(i => i.Parent == parent))
        {
            if (!seen.Add(child.Id)) continue;   // a cycle survived some hand edit
            out_.Add(child.Id);
            queue.Enqueue(child.Id);
        }
    }
    return out_;
}

/// <summary>
/// The item's own target date, or the nearest dated ancestor's.
/// <para>
/// INHERITED rather than copied down, exactly as the phase is, and for the same
/// reason: a date stamped onto every descendant at creation drifts the moment
/// the parent moves, and the copy wins in precisely the report you care about.
/// A task under a story due on the 14th is due on the 14th until somebody says
/// otherwise — and when they do, its own `due` overrides and nothing has to be
/// un-copied.
/// </para>
/// </summary>
static string EffectiveDue(List<BacklogItem> all, BacklogItem item)
{
    if (item.Due.Length > 0) return item.Due;
    foreach (var id in Ancestors(all, item.Id))
    {
        var anc = all.FirstOrDefault(i => i.Id == id);
        if (anc is { Due.Length: > 0 }) return anc.Due;
    }
    return "";
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

    return ordered
        .Select(i => i.ToSummary(EffectivePhase(all, i), childCount.GetValueOrDefault(i.Id),
                                 EffectiveDue(all, i)))
        .ToList();
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
        assignee = item.Assignee, reporter = item.Reporter,
        due = item.Due, effectiveDue = EffectiveDue(all, item),
        points = item.Points, subsystem = item.Subsystem,
        labels = item.Labels, links = item.Links, created = item.Created, updated = item.Updated,
        description = item.Description, acceptance = item.Acceptance, criteria = item.Criteria(),
        comments = item.Comments, children = childCount,
        ancestors = Ancestors(all, item.Id)
            .Select(id => all.First(i => i.Id == id))
            .Select(a => new { id = a.Id, type = a.Type, title = a.Title })
            .Reverse().ToList(),
        childItems = all.Where(i => i.Parent == item.Id)
            .OrderBy(i => i.TypeOrder).ThenBy(i => i.Id)
            .Select(c => new { id = c.Id, type = c.Type, title = c.Title, status = c.Status,
                               points = c.Points, assignee = c.Assignee,
                               due = c.Due, effectiveDue = EffectiveDue(all, c) })
            .ToList(),
    };
}
