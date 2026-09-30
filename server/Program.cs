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
// Which projects there are, and where the one global tracker lives, is
// projects.toml's business — see ProjectsFile.cs. It sits in the BugDesk
// checkout beside ui/, git-ignored, because the folders it names are this
// machine's. Each project is served at /p/<name>/ and the tracker at /t/, so a
// request says which store it means in its own URL; see the routing below.
var projectsFile = new ProjectsFile(Env("BUGDESK_PROJECTS")
    ?? Path.Combine(Path.GetDirectoryName(uiDir)!, "projects.toml"));

// The command line still names stores the way it always did (--bugs-dir,
// BUGDESK_BUGS, and the backlog beside them). The FIRST run after upgrading
// writes that store into a new projects.toml, so the repo BugDesk was already
// serving becomes its first project and nothing moves. After that the file
// decides; a store named explicitly on the command line that the file does not
// list is served for this run too, without being written into it.
bool explicitStores = ArgValue(args, "--bugs-dir") is not null || Env("BUGDESK_BUGS") is not null
                   || ArgValue(args, "--backlog-dir") is not null || Env("BUGDESK_BACKLOG") is not null;
string cliBugsDir = ResolveBugsDir(builder.Environment.ContentRootPath, args);
string cliBacklogDir = ResolveBacklogPath(cliBugsDir, args);
string cliProjectName = Path.GetFileName(Path.GetDirectoryName(cliBugsDir)!.TrimEnd('\\', '/')) is { Length: > 0 } dirName
    ? dirName : "default";

// Written whenever it is missing — the first run, a run in either mode, and a
// file deleted while BugDesk is up (ProjectsFile.Seed). The checkout's own
// store is the first project in both modes, so a file first written by
// standalone TicketDesk still gives BugDesk something to open; in tracker mode
// the tracker it opened is recorded too, so the same one shows in every project.
string? seedTracker = null;
projectsFile.Seed = () => SeedProjectsToml(cliProjectName, cliBugsDir, cliBacklogDir,
    mode == "tracker" ? seedTracker ??= ResolveTrackerBase(args) : null);
projectsFile.Seeded += () =>
    Console.WriteLine($"BugDesk: wrote {projectsFile.Path} — edit it to add projects and the tracker");
_ = projectsFile.Current;

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

var stores = new StoreRegistry(projectsFile, app.Logger, ResolveStateDir(app.Environment.ContentRootPath));
if (mode == "tracker")
{
    stores.Standalone = true;
    // Standalone TicketDesk. The tracker is the one in projects.toml, unless the
    // command line names one (--project, BUGDESK_TRACKER_PROJECT) or the file has
    // none — then it is found the way it always was, by name under the tracker
    // root.
    var named = ArgValue(args, "--project") is not null || Env("BUGDESK_TRACKER_PROJECT") is not null;
    if (named || projectsFile.Current.TrackerPath is null) stores.TrackerOverride = ResolveTrackerBase(args);
}
else if (explicitStores)
{
    var same = stores.Definitions.FirstOrDefault(d =>
        (d.Bugs is { } b && SamePath(projectsFile.Resolve(b), cliBugsDir))
        || (d.Backlog is { } k && SamePath(projectsFile.Resolve(k), cliBacklogDir)));
    if (same is null)
        stores.Transient = new ProjectsFile.ProjectDef(cliProjectName, cliBugsDir, cliBacklogDir, Env("BUGDESK_CONFIG"), null);
    stores.Preferred = same?.Name ?? cliProjectName;
}

app.Logger.LogInformation("BugDesk: mode={mode} projects={file} ({n} project(s)) tracker={tracker} ui={ui}",
    mode, projectsFile.Path, stores.Definitions.Count, stores.TrackerPath ?? "(none)", uiDir);
if (projectsFile.Error is { } projectsError)
    app.Logger.LogWarning("BugDesk: {file}: {error}", projectsFile.Path, projectsError);

// `--seed` for a tracker is applied HERE rather than in run.sh, because run.sh
// does not know where a tracker's records live — the server owns that path, and
// two places computing it is two places to get it wrong. Never overwrites: a
// store with anything in it is left exactly as it is.
if (mode == "tracker" && Env("BUGDESK_SEED_TRACKER") is not null && stores.Tracker() is { } seedInto)
{
    var backlogDir = seedInto.BacklogDir;
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
// fixed. The name is `[user]` in projects.toml — ONE name in every project and in
// the tracker — and each store's per-user PROFILE follows it (see
// StoreRegistry.Sync); the profiles still hold that store's filters and layout.
// BUGDESK_HUMAN/BUGDESK_AGENT SEED a profile when there is none yet (a scripted
// deployment, CI). BUGDESK_USER picks a different profile per process, for two
// people sharing one checkout, and leaves the file alone.

// Pre-profile UI state: a single shared filters.json. Read once, folded into
// whichever profile is active, and never written again.
string legacyFiltersPath = Path.Combine(ResolveStateDir(app.Environment.ContentRootPath), "filters.json");
if (mode != "tracker" && stores.DefaultProject is { } firstProject)
    stores.Project(firstProject.Name)?.Users.MigrateLegacyFilters(legacyFiltersPath);

// ---- Routing: which store a request is for ---------------------------------
// The UI is served UNDER its store's prefix — /p/bugdesk/, /t/ — and addresses
// its API relatively, so everything a page asks for reaches the store it was
// opened on without a single call site knowing which one that is. The prefix is
// moved into PathBase here, so the static files and every endpoint below see the
// same paths they always did, and the store travels with the request in
// Req.Store.
//
// A bare address opens a project — the one used last — and an unprefixed /api
// call (a script, an old tab) goes to that same project. In standalone tracker
// mode there is only the tracker, and everything is it.
app.Use(async (http, next) =>
{
    var path = http.Request.Path.Value ?? "/";
    Store? store;
    if (path.StartsWith("/p/", StringComparison.Ordinal))
    {
        var rest = path[3..];
        var slash = rest.IndexOf('/');
        var name = Uri.UnescapeDataString(slash < 0 ? rest : rest[..slash]);
        // Relative URLs need the trailing slash, or `api/config` resolves to /p/api/config.
        if (slash < 0) { http.Response.Redirect($"/p/{Uri.EscapeDataString(name)}/{http.Request.QueryString}"); return; }
        var tail = rest[slash..];
        store = stores.Project(name);
        if (store is null)
        {
            if (tail.StartsWith("/api/", StringComparison.Ordinal))
                await Fail(http, 404, $"no project called '{name}' in {projectsFile.Path}");
            else
                http.Response.Redirect("/");
            return;
        }
        http.Request.PathBase = path[..(3 + slash)];
        http.Request.Path = tail;
        if (tail is "/" or "/index.html") stores.MarkUsed(store.Name);
    }
    else if (path == "/t" || path.StartsWith("/t/", StringComparison.Ordinal))
    {
        if (path == "/t") { http.Response.Redirect("/t/"); return; }
        store = stores.Tracker();
        if (store is null) { await Fail(http, 404, stores.TrackerPath is null
            ? $"no tracker configured — set [tracker] path in {projectsFile.Path}"
            : $"the tracker is switched off — [tracker] enabled = false in {projectsFile.Path}"); return; }
        http.Request.PathBase = "/t";
        http.Request.Path = path[2..];
    }
    else if (mode == "tracker")
    {
        store = stores.Tracker();
    }
    else
    {
        var def = stores.DefaultProject;
        if (path is "/" or "/index.html")
        {
            if (def is null) { await Fail(http, 404, $"no projects yet — add one to {projectsFile.Path}"); return; }
            http.Response.Redirect($"/p/{Uri.EscapeDataString(def.Name)}/{http.Request.QueryString}");
            return;
        }
        store = def is null ? null : stores.Project(def.Name);
    }

    // A project need not have both stores, and the endpoints of the one it lacks
    // must not run against an empty path — a bug path with no folder in front of
    // it resolves against the server's working directory.
    var api = http.Request.Path.Value ?? "";
    if (api.StartsWith("/api/", StringComparison.Ordinal) && !api.StartsWith("/api/projects", StringComparison.Ordinal))
    {
        if (store is null) { await Fail(http, 404, $"no projects yet — add one to {projectsFile.Path}"); return; }
        if (!store.HasBugs && (api.StartsWith("/api/bugs", StringComparison.Ordinal) || api == "/api/meta"))
        { await Fail(http, 404, $"{store.Name} has no bug store"); return; }
        if (!store.HasBacklog && api.StartsWith("/api/backlog", StringComparison.Ordinal))
        { await Fail(http, 404, $"{store.Name} has no backlog"); return; }
    }

    // The TRACKER'S COPY of the record modules. A project page shows the global
    // tracker beside its own stores by loading ui/js/ticketdesk/ a second time
    // from this alias: a different URL is a separate module instance, with its
    // own records, its own API address and its own page kinds, while everything
    // outside ticketdesk/ (the window manager, the taxonomy, settings) resolves
    // to the same URLs and stays shared. See ui/js/ticketdesk/instance.js.
    if (http.Request.Path.Value is { } js && js.StartsWith("/js/ticketdesk@t/", StringComparison.Ordinal))
        http.Request.Path = "/js/ticketdesk/" + js["/js/ticketdesk@t/".Length..];

    Req.Maybe = store;
    await next();
});
// Explicit, and AFTER the rewrite: left implicit, WebApplication matches routes
// at the very start of the pipeline — against the path WITH its /p/<name>
// prefix — and no endpoint below would ever match a prefixed request.
app.UseRouting();

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
// Images pasted or dropped into a description / comment land in the store's
// attachments folder (<bugs>/attachments in a project, beside the tickets in the
// tracker) and are referenced from the markdown as `/attachments/<name>`. They
// live WITH the store on purpose: a screenshot is part of the record, and keeping
// it beside the .md means the two travel together in git rather than rotting as
// a dead link.
//
// The reference is ROOT-relative and names no store, and it stays that way: it is
// written into records, and a record must not change meaning when it is read from
// another page. The names are content hashes, so the same name is the same image
// wherever it is found — the request's own store is asked first, then the
// tracker, then every other open store.
app.MapGet("/attachments/{name}", (string name) =>
{
    var type = ImageContentType(name);
    if (type is null || name.Contains("..") || name.IndexOfAny(new[] { '/', '\\' }) >= 0)
        return Results.NotFound();
    var candidates = new List<Store>();
    if (Req.Maybe is { } own) candidates.Add(own);
    if (stores.Tracker() is { } tracker) candidates.Add(tracker);
    candidates.AddRange(stores.Open());
    foreach (var s in candidates.Distinct())
    {
        var full = Path.Combine(s.AttachDir, name);
        if (File.Exists(full)) return Results.File(full, type);
    }
    return Results.NotFound();
});

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
    var full = Path.Combine(Req.Store.AttachDir, fileName);
    if (!File.Exists(full)) await File.WriteAllBytesAsync(full, bytes);

    return Results.Json(new { ok = true, url = $"/attachments/{fileName}", name = fileName }, json);
});

// ---- Bugs -----------------------------------------------------------------

app.MapGet("/api/bugs", () =>
{
    var list = LoadAll(Req.Store.BugsDir).OrderBy(b => b.Pri).ThenByDescending(b => b.Updated).Select(b => b.ToSummary()).ToList();
    return Results.Json(new { ok = true, bugs = list }, json);
});

app.MapGet("/api/bugs/{id:int}", (int id) =>
{
    var bug = LoadOne(Req.Store.BugsDir, id);
    return bug is null
        ? Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404)
        : Results.Json(new { ok = true, bug }, json);
});

// An unset field acquiring its own default is not a decision somebody made, so
// it is not an audit entry. `assignee:` empty on a legacy record becoming the
// configured human on the first ordinary save is exactly that, and a line
// recording it would be a reassignment nobody performed.
bool IsDefaultFill(string key, string was, string now) =>
    (key is "assignee" or "reporter") && was.Length == 0 && now == Req.Store.Users.HumanAuthor;

// An actor name goes into a history line as `- <date> · <actor> · …`, so the two
// characters it must not contain are a newline and the separator itself. A
// newline is the damaging one: it emits a second, flush-left line inside
// `## History`, and SetFrontmatter's document-wide `^key:` match will then latch
// onto that line instead of inserting into the frontmatter — the next honest
// write reports success and changes nothing. The leading bullet is what protects
// the format, and an embedded newline is precisely what gets past it.
static string CleanActor(string? raw) =>
    System.Text.RegularExpressions.Regex.Replace(raw ?? "", @"[\r\n·]+", " ").Trim();

app.MapPost("/api/bugs/{id:int}", async (int id, HttpRequest req) =>
{
    var path = BugPath(Req.Store.BugsDir, id);
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var patch = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var text = await File.ReadAllTextAsync(path);

    // Who is making the change. NEVER written to frontmatter — it is only ever the
    // actor column of a history line — and it defaults to the human because this API
    // is the human's UI; an agent says so explicitly. An old client sending no
    // `actor` still works. Same trust model as the comment endpoints' `author`: a
    // local tool over files a person can edit anyway.
    var actor = patch.TryGetValue("actor", out var av) && av.ValueKind == JsonValueKind.String
        ? CleanActor(av.GetString()) : "";
    if (actor.Length == 0) actor = Req.Store.Users.HumanAuthor;

    var changes = new List<FieldChange>();
    foreach (var (k, v) in patch)
    {
        var key = k.ToLowerInvariant();
        // assignee and reporter are EXPLICIT — set by the user, never derived.
        if (key is "status" or "severity" or "subsystem" or "type" or "title" or "assignee" or "reporter")
        {
            var val = (v.ValueKind == JsonValueKind.String ? v.GetString()! : v.ToString()).Trim();
            // Read the OLD value off the text we are about to change. Every key is
            // written once, so this is always what the file had on disk — and a
            // history entry records a TRANSITION, so a save that re-sends the value
            // it already had writes nothing: the mask posts most fields on every
            // save, and a line per save is not a history.
            var was = (Md.GetFrontmatter(text, key) ?? "").Trim();
            if (RecordHistory.Tracked(key) && was != val && !IsDefaultFill(key, was, val))
                changes.Add(new FieldChange(key, was, val));
            text = key == "reporter"
                ? Md.SetFrontmatterAfter(text, "reporter", val, "assignee")
                : Md.SetFrontmatter(text, key, val);
        }
        else if (key is "labels" or "links" && v.ValueKind == JsonValueKind.Array)
            text = Md.SetFrontmatter(text, key, Md.ListValue(v.EnumerateArray().Select(e => e.GetString() ?? "")));
    }

    text = RecordHistory.Append(text, actor, changes);
    text = Md.SetFrontmatter(text, "updated", Md.Now());

    // A STATUS CHANGE AND ITS MESSAGE. Close, reopen, hand to testing, back to
    // investigation and back to open each come with a message, shown in the
    // comment thread with a status tag (`status: testing -> closed` in the
    // header's note). Either the request carries the message, and it is written
    // here in the same write, or the actor commented moments ago
    // (`tagRecentComment`), and that comment becomes the message.
    //
    // FOR THE FUTURE: on a platform with a workflow engine, the engine should own
    // this — which transitions need a message, the five-minute window, and the
    // link between a transition and its message — and this bridge should only
    // store what it is told. Until then it lives here, at write time, as the
    // smallest thing that works: a note in a header the format already had.
    var statusChange = changes.FirstOrDefault(c => c.Field == "status");
    var statusNote = statusChange is null ? null : $"status: {statusChange.From} -> {statusChange.To}";
    if (patch.TryGetValue("comment", out var cv) && cv.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(cv.GetString()))
        text = Md.AppendComment(text, actor, cv.GetString()!, statusNote);
    else if (statusNote is not null && patch.TryGetValue("tagRecentComment", out var tv) && tv.ValueKind == JsonValueKind.True)
        text = Md.TagRecentComment(text, actor, statusNote, DateTime.UtcNow).Text;
    await Req.Store.WriteRecord(path, text);
    return Results.Json(new { ok = true, bug = LoadOne(Req.Store.BugsDir, id) }, json);
});

// Marking a duplicate is ONE act, not four requests a client can get half-way
// through: the link, the close, the history line, a comment saying what this was
// folded into, and a comment on the master saying what arrived. Named for the
// assertion it makes, not for copying anything.
//
// Two records are in play and the master may be of either kind, so every local
// below is named for its ROLE: `self` is the record being closed (the one this
// route is addressed to), `targetBug` / `targetItem` the resolved master. A bare
// `item` reads correctly whichever of the two the writer meant, which is exactly
// why it is not used.
app.MapPost("/api/bugs/{id:int}/duplicate-of", async (int id, HttpRequest req) =>
{
    var path = BugPath(Req.Store.BugsDir, id);        // `self`'s file — the only one the pipeline below writes
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);

    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var raw = (body.TryGetValue("target", out var tv) ? tv.ValueKind switch
    {
        JsonValueKind.String => tv.GetString() ?? "",
        JsonValueKind.Number => tv.TryGetInt32(out var tn) ? tn.ToString() : "",
        _ => "",
    } : "").Trim();
    // Accepted and never persisted: `actor` is only ever the actor column of a
    // history line. Same trust model the comment endpoints' `author` already has.
    var actor = body.TryGetValue("actor", out var av) && av.ValueKind == JsonValueKind.String
        ? CleanActor(av.GetString()) : "";
    if (actor.Length == 0) actor = Req.Store.Users.HumanAuthor;
    var note = body.TryGetValue("comment", out var cv) && cv.ValueKind == JsonValueKind.String
        ? (cv.GetString() ?? "").Trim() : "";

    if (raw.Length == 0) return Results.Json(new { ok = false, error = "target required" }, json, statusCode: 400);
    var r = Refs.Parse(raw, "bugs");        // the MASTER's ref, never self's
    if (!r.Ok) return Results.Json(new { ok = false, error = $"'{raw}' is not a record reference" }, json, statusCode: 400);
    if (r.Store == "bugs" && r.Id == id)
        return Results.Json(new { ok = false, error = "a bug cannot be a duplicate of itself" }, json, statusCode: 400);

    // Resolve the master before writing anything: the response owes the client a
    // title, and the FOUND record's type is what supplies the prefix, so a stale
    // `STORY-7` aimed at an epic is recorded as EPIC-0007 rather than preserved
    // as whatever somebody typed.
    string targetTitle, targetType, targetPath;
    if (r.Store == "bugs")
    {
        var targetBug = LoadOne(Req.Store.BugsDir, r.Id);
        if (targetBug is null) return Results.Json(new { ok = false, error = $"no bug #{r.Id} to point at" }, json, statusCode: 404);
        targetTitle = targetBug.Title;
        targetType = "";
        targetPath = BugPath(Req.Store.BugsDir, r.Id);
    }
    else
    {
        var targetItem = LoadBacklog(Req.Store.BacklogDir).FirstOrDefault(i => i.Id == r.Id);
        if (targetItem is null) return Results.Json(new { ok = false, error = $"no backlog item #{r.Id} to point at" }, json, statusCode: 404);
        targetTitle = targetItem.Title;
        targetType = targetItem.Type;
        targetPath = Path.Combine(Req.Store.BacklogDir, targetItem.FileName);
    }
    var token = $"duplicates {Refs.Format(r, "bugs", targetType)}";
    var targetDisplay = Refs.Display(r, targetType);
    var selfDisplay = Refs.Display(new RecordRef("bugs", id));

    var text = await File.ReadAllTextAsync(path);
    // Merge rather than replace: the patch endpoint's array semantics are
    // full-replace, so the merge has to happen here or an existing link is lost.
    var links = Md.List(Md.GetFrontmatter(text, "links"));
    if (!links.Any(l => string.Equals(l.Trim(), token, StringComparison.OrdinalIgnoreCase))) links.Add(token);
    text = Md.SetFrontmatter(text, "links", Md.ListValue(links));

    // `assignee` is deliberately untouched: closing a duplicate is not a handback.
    var was = (Md.GetFrontmatter(text, "status") ?? "open").Trim();
    if (was != "closed")
    {
        text = Md.SetFrontmatter(text, "status", "closed");
        text = RecordHistory.Append(text, actor, new[] { new FieldChange("status", was, "closed") });
    }
    // AppendComment is LAST in any multi-step write: it appends at end of file and
    // bumps `updated`, and History must already be above the thread.
    text = Md.AppendComment(text, actor,
        note.Length > 0 ? note : $"Closed as a duplicate of {targetDisplay} — {targetTitle}.");
    await Req.Store.WriteRecord(path, text);

    // A courtesy comment on the master, never a reverse link — only the authored
    // direction of a relationship is ever stored. The duplicate is written FIRST
    // on purpose: an interruption between the two leaves a correctly closed,
    // correctly linked duplicate and a master merely uninformed, rather than a
    // master announcing a merge that never happened.
    var targetNoted = false;
    try
    {
        await Req.Store.WriteRecord(targetPath, Md.AppendComment(await File.ReadAllTextAsync(targetPath), actor,
            $"{selfDisplay} was closed as a duplicate of this."));
        targetNoted = true;
    }
    catch (Exception ex) { app.Logger.LogWarning(ex, "could not note the duplicate on {Ref}", targetDisplay); }

    // The master comes back as store + id + ref + title rather than as a record:
    // it may be a Bug or a BacklogItem, and a polymorphic field is a shape the
    // client would have to sniff.
    return Results.Json(new
    {
        ok = true,
        bug = LoadOne(Req.Store.BugsDir, id),                 // `self`, re-read after the write
        target = new { store = r.Store, id = r.Id, @ref = targetDisplay, title = targetTitle },
        targetNoted,
    }, json);
});

app.MapPost("/api/bugs/{id:int}/comments", async (int id, HttpRequest req) =>
{
    var path = BugPath(Req.Store.BugsDir, id);
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var author = body.TryGetValue("author", out var a) ? a.GetString() : Req.Store.Users.HumanAuthor;
    var comment = body.TryGetValue("body", out var b) ? b.GetString() : "";
    if (string.IsNullOrWhiteSpace(comment)) return Results.Json(new { ok = false, error = "empty comment" }, json, statusCode: 400);

    var text = Md.AppendComment(await File.ReadAllTextAsync(path), author ?? Req.Store.Users.HumanAuthor, comment!);
    await Req.Store.WriteRecord(path, text);
    return Results.Json(new { ok = true, bug = LoadOne(Req.Store.BugsDir, id) }, json);
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

    var nextId = LoadAll(Req.Store.BugsDir).Select(b => b.Id).DefaultIfEmpty(0).Max() + 1;
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
    sb.Append($"assignee: {Get("assignee", Req.Store.Users.HumanAuthor)}\n");
    // Who it goes BACK to. Set once here and never derived: "the human" is not a
    // stable answer in a project with a roster, and a handback that guesses hands
    // somebody else's bug to the wrong person.
    sb.Append($"reporter: {Get("reporter", Req.Store.Users.HumanAuthor)}\n");
    sb.Append($"labels: [{labels}]\n");
    sb.Append($"links: [{links}]\n");
    sb.Append($"created: {Md.Today()}\n");
    sb.Append($"updated: {Md.Now()}\n");
    sb.Append("---\n\n## Description\n\n");
    sb.Append(string.IsNullOrWhiteSpace(description) ? "_(no description provided)_" : description);
    sb.Append('\n');

    await Req.Store.WriteRecord(BugPath(Req.Store.BugsDir, nextId), sb.ToString());
    return Results.Json(new { ok = true, bug = LoadOne(Req.Store.BugsDir, nextId) }, json);
});

app.MapGet("/api/meta", () =>
{
    var all = LoadAll(Req.Store.BugsDir);
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
    Results.Json(new { ok = true, items = BacklogSummaries(Req.Store.BacklogDir) }, json));

app.MapGet("/api/backlog/meta", () =>
{
    var all = LoadBacklog(Req.Store.BacklogDir);
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
    var all = LoadBacklog(Req.Store.BacklogDir);
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

    var all = LoadBacklog(Req.Store.BacklogDir);
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
        Reporter = Get("reporter", Req.Store.Users.HumanAuthor),
        Due = BacklogItem.NormalizeDate(due),
        Points = Get("points"),
        Subsystem = Get("subsystem", "unsorted"),
        Labels = GetList("labels"),
        Links = GetList("links"),
        Created = Md.Today(),
        Updated = Md.Now(),
        Description = Get("description"),
        Acceptance = Get("acceptance"),
    };
    await Req.Store.WriteRecord(Path.Combine(Req.Store.BacklogDir, item.FileName), item.Render());

    var reloaded = LoadBacklog(Req.Store.BacklogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == item.Id)) }, json);
});

app.MapPost("/api/backlog/{id:int}", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(Req.Store.BacklogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(Req.Store.BacklogDir, item.FileName);

    // The status the record had BEFORE this request. The retype clamp below can
    // move the status with no `status` key in the patch at all, and this is the
    // only value that makes such a move visible.
    var statusBefore = item.Status.Trim();
    var changes = new List<FieldChange>();

    var patch = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();

    // Who is making the change. NEVER written to frontmatter — it is only ever the
    // actor column of a history line — and it defaults to the human because this API
    // is the human's UI; an agent says so explicitly. An old client sending no
    // `actor` still works. Same trust model as the comment endpoints' `author`.
    var actor = patch.TryGetValue("actor", out var av) && av.ValueKind == JsonValueKind.String
        ? CleanActor(av.GetString()) : "";
    if (actor.Length == 0) actor = Req.Store.Users.HumanAuthor;

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
                // Read off the text we are about to change: a save that re-sends the
                // status it already had is not a transition and writes no line.
                var wasStatus = (Md.GetFrontmatter(text, "status") ?? "").Trim();
                if (wasStatus != str.Trim()) changes.Add(new FieldChange("status", wasStatus, str.Trim()));
                text = Md.SetFrontmatter(text, "status", str);
                newStatus = str;
                break;
            }
            case "phase" or "assignee" or "reporter" or "points" or "subsystem" or "title":
            {
                var was = (Md.GetFrontmatter(text, key) ?? "").Trim();
                if (RecordHistory.Tracked(key) && was != str.Trim() && !IsDefaultFill(key, was, str.Trim()))
                    changes.Add(new FieldChange(key, was, str.Trim()));
                // `reporter` is anchored after `assignee` the same way the bug
                // handler anchors it, because that is where Render() puts it. A
                // plain SetFrontmatter would insert an absent key just before the
                // closing `---`, so the same field would sit in two different
                // places depending on whether the record was created by the API
                // or backfilled by a patch.
                text = key == "reporter"
                    ? Md.SetFrontmatterAfter(text, "reporter", str.Trim(), "assignee")
                    : Md.SetFrontmatter(text, key, key == "title" ? $"\"{Md.Quote(str)}\"" : str);
                break;
            }
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

    // The clamp can move the status on its own: a patch of {type:'task'} alone on a
    // story in `review` demotes it to `in-progress` with no `status` key anywhere in
    // the request. Comparing against the record AS LOADED is the only way to see
    // that — the one status change a reader cannot explain from the frontmatter is
    // exactly the one an audit trail must not omit. Reconcile by comparison, never
    // by patching an entry that may not exist.
    var finalStatus = (Md.GetFrontmatter(text, "status") ?? "").Trim();
    var si = changes.FindIndex(c => c.Field == "status");
    if (finalStatus != statusBefore)
    {
        if (si >= 0) changes[si] = changes[si] with { To = finalStatus };
        else changes.Add(new FieldChange("status", statusBefore, finalStatus));
    }
    else if (si >= 0) changes.RemoveAt(si);      // clamped straight back: nothing happened

    // Before the retype branch below, so the same `text` is what gets written to
    // whichever path the record ends up at.
    text = RecordHistory.Append(text, actor, changes);
    text = Md.SetFrontmatter(text, "updated", Md.Now());

    if (retype is not null && retype != item.Type)
    {
        // Write the NEW file first, then drop the old one: an interruption
        // between the two leaves the record duplicated (visible, fixable by
        // hand) rather than deleted (gone).
        var next = Path.Combine(Req.Store.BacklogDir, $"{BacklogItem.Prefixes[retype]}-{id:D4}.md");
        await Req.Store.WriteRecord(next, text);
        File.Delete(path);
    }
    else
    {
        await Req.Store.WriteRecord(path, text);
    }

    var reloaded = LoadBacklog(Req.Store.BacklogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// Acceptance criteria as a real checklist. One line at a time, addressed by
// its position among the section's checkboxes, so ticking a box rewrites that
// box and nothing else — the section is hand-authored markdown and may carry
// context the UI never parsed.
app.MapPost("/api/backlog/{id:int}/criteria", async (int id, HttpRequest req) =>
{
    var all = LoadBacklog(Req.Store.BacklogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(Req.Store.BacklogDir, item.FileName);

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

    await Req.Store.WriteRecord(path, Md.SetFrontmatter(next, "updated", Md.Now()));

    var reloaded = LoadBacklog(Req.Store.BacklogDir);
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
    var all = LoadBacklog(Req.Store.BacklogDir);
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
    var trash = Path.Combine(Req.Store.ConfigDir, "trash");
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
            var path = Path.Combine(Req.Store.BacklogDir, child.FileName);
            var text = Md.SetFrontmatter(await File.ReadAllTextAsync(path), "parent",
                item.Parent > 0 ? item.Parent.ToString() : "");
            await Req.Store.WriteRecord(path, Md.SetFrontmatter(text, "updated", Md.Now()));
            promoted.Add(child.Id);
        }
    }

    foreach (var doom in doomed)
    {
        var from = Path.Combine(Req.Store.BacklogDir, doom.FileName);
        if (!File.Exists(from)) continue;
        Req.Store.Watcher.NoteDeletion(from);
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
    var all = LoadBacklog(Req.Store.BacklogDir);
    var item = all.FirstOrDefault(i => i.Id == id);
    if (item is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(Req.Store.BacklogDir, item.FileName);

    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var author = body.TryGetValue("author", out var a) ? a.GetString() : Req.Store.Users.HumanAuthor;
    var comment = body.TryGetValue("body", out var b) ? b.GetString() : "";
    if (string.IsNullOrWhiteSpace(comment)) return Results.Json(new { ok = false, error = "empty comment" }, json, statusCode: 400);

    await Req.Store.WriteRecord(path, Md.AppendComment(await File.ReadAllTextAsync(path), author ?? Req.Store.Users.HumanAuthor, comment!));

    var reloaded = LoadBacklog(Req.Store.BacklogDir);
    return Results.Json(new { ok = true, item = FullItem(reloaded, reloaded.First(i => i.Id == id)) }, json);
});

// The backlog half of the duplicate-of act. Same shape as the bug endpoint, with
// two differences that matter: the terminal status is `dropped` — the only one
// every backlog type's ladder admits, and the only one that does not claim the
// work was finished — and BOTH records here may be BacklogItems, which is why
// `self` (the record being dropped) and `targetItem` (the resolved master) never
// share a name.
app.MapPost("/api/backlog/{id:int}/duplicate-of", async (int id, HttpRequest req) =>
{
    var self = LoadBacklog(Req.Store.BacklogDir).FirstOrDefault(i => i.Id == id);
    if (self is null) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var path = Path.Combine(Req.Store.BacklogDir, self.FileName);

    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var raw = (body.TryGetValue("target", out var tv) ? tv.ValueKind switch
    {
        JsonValueKind.String => tv.GetString() ?? "",
        JsonValueKind.Number => tv.TryGetInt32(out var tn) ? tn.ToString() : "",
        _ => "",
    } : "").Trim();
    // Accepted and never persisted: `actor` is only ever the actor column of a
    // history line. Same trust model the comment endpoints' `author` already has.
    var actor = body.TryGetValue("actor", out var av) && av.ValueKind == JsonValueKind.String
        ? CleanActor(av.GetString()) : "";
    if (actor.Length == 0) actor = Req.Store.Users.HumanAuthor;
    var note = body.TryGetValue("comment", out var cv) && cv.ValueKind == JsonValueKind.String
        ? (cv.GetString() ?? "").Trim() : "";

    if (raw.Length == 0) return Results.Json(new { ok = false, error = "target required" }, json, statusCode: 400);
    var r = Refs.Parse(raw, "backlog");     // the MASTER's ref, never self's
    if (!r.Ok) return Results.Json(new { ok = false, error = $"'{raw}' is not a record reference" }, json, statusCode: 400);
    if (r.Store == "backlog" && r.Id == id)
        return Results.Json(new { ok = false, error = "an item cannot be a duplicate of itself" }, json, statusCode: 400);

    // An item may be a duplicate of a bug, so the master is resolved out of either
    // store, and the FOUND record's type is what supplies the prefix.
    string targetTitle, targetType, targetPath;
    if (r.Store == "bugs")
    {
        var targetBug = LoadOne(Req.Store.BugsDir, r.Id);
        if (targetBug is null) return Results.Json(new { ok = false, error = $"no bug #{r.Id} to point at" }, json, statusCode: 404);
        targetTitle = targetBug.Title;
        targetType = "";
        targetPath = BugPath(Req.Store.BugsDir, r.Id);
    }
    else
    {
        var targetItem = LoadBacklog(Req.Store.BacklogDir).FirstOrDefault(i => i.Id == r.Id);
        if (targetItem is null) return Results.Json(new { ok = false, error = $"no backlog item #{r.Id} to point at" }, json, statusCode: 404);
        targetTitle = targetItem.Title;
        targetType = targetItem.Type;
        targetPath = Path.Combine(Req.Store.BacklogDir, targetItem.FileName);
    }
    var token = $"duplicates {Refs.Format(r, "backlog", targetType)}";
    var targetDisplay = Refs.Display(r, targetType);
    // self.Type, because this string names `self` in the MASTER's comment.
    var selfDisplay = Refs.Display(new RecordRef("backlog", id), self.Type);

    var text = await File.ReadAllTextAsync(path);
    // Merge rather than replace: the patch endpoint's array semantics are
    // full-replace, so the merge has to happen here or an existing link is lost.
    var links = Md.List(Md.GetFrontmatter(text, "links"));
    if (!links.Any(l => string.Equals(l.Trim(), token, StringComparison.OrdinalIgnoreCase))) links.Add(token);
    text = Md.SetFrontmatter(text, "links", Md.ListValue(links));

    // `assignee` is deliberately untouched: dropping a duplicate is not a handback.
    var was = (Md.GetFrontmatter(text, "status") ?? "").Trim();
    if (was != "dropped")
    {
        text = Md.SetFrontmatter(text, "status", "dropped");
        text = RecordHistory.Append(text, actor, new[] { new FieldChange("status", was, "dropped") });
    }
    // AppendComment is LAST in any multi-step write: it appends at end of file and
    // bumps `updated`, and History must already be above the thread.
    text = Md.AppendComment(text, actor,
        note.Length > 0 ? note : $"Dropped as a duplicate of {targetDisplay} — {targetTitle}.");
    await Req.Store.WriteRecord(path, text);

    // A courtesy comment on the master, never a reverse link. The duplicate is
    // written FIRST on purpose: an interruption between the two leaves a correctly
    // dropped, correctly linked duplicate and a master merely uninformed, rather
    // than a master announcing a merge that never happened.
    var targetNoted = false;
    try
    {
        await Req.Store.WriteRecord(targetPath, Md.AppendComment(await File.ReadAllTextAsync(targetPath), actor,
            $"{selfDisplay} was dropped as a duplicate of this."));
        targetNoted = true;
    }
    catch (Exception ex) { app.Logger.LogWarning(ex, "could not note the duplicate on {Ref}", targetDisplay); }

    var reloaded = LoadBacklog(Req.Store.BacklogDir);
    return Results.Json(new
    {
        ok = true,
        item = FullItem(reloaded, reloaded.First(i => i.Id == id)),   // `self`, re-read after the write
        target = new { store = r.Store, id = r.Id, @ref = targetDisplay, title = targetTitle },
        targetNoted,
    }, json);
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

    // "#42" is bug 42 and "#STORY-0007" is that item: ONE record, not every
    // record whose text happens to contain the digits. A bare number means a
    // bug here whichever page you search from, because that is how a bug is
    // named everywhere in the UI. Anything after "#" that is not a reference
    // ("#todo") is searched as ordinary text.
    var trimmed = (q ?? "").Trim();
    var exact = trimmed.StartsWith('#') ? Refs.Parse(trimmed[1..], "bugs") : default;

    void Consider(SearchDoc doc)
    {
        if (exact.Ok)
        {
            if (doc.Store == exact.Store && doc.Id == exact.Id)
                hits.Add(new SearchHit(doc, 0, "reference", Snippet(doc.Title, doc.Ref)));
            return;
        }
        if (Match(doc, terms) is { } hit) hits.Add(hit);
    }

    foreach (var bug in LoadAll(Req.Store.BugsDir))
    {
        Consider(new SearchDoc(
            Store: "bugs", Id: bug.Id, Ref: $"BUG-{bug.Id:D4}", Type: bug.Type,
            Title: bug.Title, Status: bug.Status, Assignee: bug.Assignee, Updated: bug.Updated,
            Description: bug.Description,
            Extra: string.Join(' ', bug.Labels.Concat(new[] { bug.Subsystem, bug.Severity })),
            Comments: bug.Comments));
    }

    var all = LoadBacklog(Req.Store.BacklogDir);
    foreach (var item in all)
    {
        Consider(new SearchDoc(
            Store: "backlog", Id: item.Id, Ref: $"{BacklogItem.Prefixes.GetValueOrDefault(item.Type, "TASK")}-{item.Id:D4}",
            Type: item.Type, Title: item.Title, Status: item.Status, Assignee: item.Assignee,
            Updated: item.Updated, Description: item.Description,
            Extra: string.Join(' ', item.Labels.Concat(new[] { item.Subsystem, item.Phase, item.Points, item.Acceptance })),
            Comments: item.Comments));
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
// The payload both config endpoints answer with: who you are, the store this
// page is on, and the projects and tracker around it.
object ConfigPayload(Store s, string? slug = null) => new
{
    ok = true,
    // Which app this page is. The UI reads it before it evaluates a single page
    // module (see ui/index.html) because the taxonomy — which top-nav chips
    // exist, and what they are called — is built at module load.
    mode = s.IsTracker ? "tracker" : "bugs",
    // Which APP this is — decided by how the server was STARTED, never by the
    // page: `--tracker` is TicketDesk, everything else is BugDesk, including
    // the tracker's own page (/t/) inside a BugDesk.
    app = mode == "tracker" ? "ticketdesk" : "bugdesk",
    // Whether `<name>_agent` is a thing you can assign work to here.
    agentsAssignable = s.AgentsAssignable,
    humanAuthor = s.Users.HumanAuthor,
    agentAuthor = s.Users.AgentAuthor,
    configured = s.Users.Configured,
    user = slug ?? s.Users.ActiveSlug,
    profiles = s.Users.Profiles(),
    configDir = s.Users.ConfigDir,
    collaborators = s.Project.Collaborators(),
    assignees = s.Project.Assignees(),
    // The store this page is on, and which of its two halves exist.
    store = new { kind = s.Kind, name = s.Name, hasBugs = s.HasBugs, hasBacklog = s.HasBacklog, @base = s.UrlBase },
    projects = ProjectList(),
    tracker = new { available = stores.TrackerAvailable, @base = "/t/", path = stores.TrackerPath },
    projectsFile = projectsFile.Path,
    projectsError = projectsFile.Error,
};

// The client fetches this once, before it renders anything, so every "who is
// posting this comment" / "on me" / "on the agent" default reflects the
// configured names instead of a hardcoded pair. `configured: false` is what
// triggers the first-run name prompt. See ui/index.html.
app.MapGet("/api/config", () => Results.Json(ConfigPayload(Req.Store), json));

// First run (or "switch user"): who you are, in every project and the tracker.
// Written to projects.toml's [user] — ONE name — and adopted by this store's
// profile on the spot; every other store follows on its next request (see
// StoreRegistry.Sync).
app.MapPost("/api/config/user", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var name = body.TryGetValue("name", out var n) ? (n.GetString() ?? "").Trim() : "";
    if (name.Length == 0)
        return Results.Json(new { ok = false, error = "name required" }, json, statusCode: 400);
    if (name.Length > 60)
        return Results.Json(new { ok = false, error = "name must be 60 characters or fewer" }, json, statusCode: 400);

    var typed = body.TryGetValue("agentName", out var a) ? (a.GetString() ?? "").Trim() : "";
    var s = Req.Store;
    // An unnamed agent is DERIVED, not left generic: every person's assistant
    // needs a distinguishable name or two people's agents sign the same way.
    // Except in the tracker, where nobody in the store has an assistant and a
    // `<name>_agent` beside every person is an entry no picker can use. Only a
    // name the person TYPED goes into projects.toml; a derived one is derived
    // again per store.
    var agent = typed.Length > 0 ? typed : s.AgentsAssignable ? ProjectConfig.AgentNameFor(name) : null;
    if (Environment.GetEnvironmentVariable("BUGDESK_USER") is not { Length: > 0 })
        projectsFile.SetUser(name, typed.Length > 0 ? typed : null);
    var slug = s.Users.SelectOrCreate(name, agent);
    s.Users.MigrateLegacyFilters(legacyFiltersPath);
    s.Project.Upsert(name, agent);
    app.Logger.LogInformation("BugDesk: user profile {slug} selected", slug);

    return Results.Json(ConfigPayload(s, slug), json);
});

// ---- Projects ---------------------------------------------------------------
// The switcher's list, and adding or removing an entry. These edit
// projects.toml and nothing else: removing a project never touches its folders.
List<object> ProjectList() => stores.Definitions.Select(d => (object)new
{
    name = d.Name,
    bugs = d.Bugs is { } b ? projectsFile.Resolve(b) : null,
    backlog = d.Backlog is { } k ? projectsFile.Resolve(k) : null,
    hasBugs = d.Bugs is not null,
    hasBacklog = d.Backlog is not null,
    @base = $"/p/{Uri.EscapeDataString(d.Name)}/",
    // Named on the command line and not in the file: nothing to remove.
    transient = stores.Transient is { } t && t.Name == d.Name && !projectsFile.Current.Projects.Any(p => p.Name == d.Name),
}).ToList();

object ProjectsPayload() => new
{
    ok = true,
    file = projectsFile.Path,
    error = projectsFile.Error,
    projects = ProjectList(),
    tracker = new { available = stores.TrackerAvailable, path = stores.TrackerPath },
};

app.MapGet("/api/projects", () => Results.Json(ProjectsPayload(), json));

app.MapPost("/api/projects", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    string Get(string k) => body.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "").Trim() : "";
    var name = Get("name");
    if (name.Length == 0 || name.Length > 60)
        return Results.Json(new { ok = false, error = "a project needs a name of 1–60 characters" }, json, statusCode: 400);
    if (name.IndexOfAny(new[] { '/', '\\', '"', '\'' }) >= 0 || name.Any(char.IsControl))
        return Results.Json(new { ok = false, error = "a project name cannot contain / \\ or quotes" }, json, statusCode: 400);
    if (stores.Definitions.Any(d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase)))
        return Results.Json(new { ok = false, error = $"there is already a project called {name}" }, json, statusCode: 409);

    var bugs = Get("bugs");
    var backlog = Get("backlog");
    if (bugs.Length == 0 && backlog.Length == 0)
        return Results.Json(new { ok = false, error = "give a bugs folder, a backlog folder, or both" }, json, statusCode: 400);
    // A folder the store can be made in: the store itself may be new, its parent
    // may not — that is what catches a mistyped path before it is saved.
    foreach (var (label, dir) in new[] { ("bugs", bugs), ("backlog", backlog) })
    {
        if (dir.Length == 0) continue;
        if (!Path.IsPathFullyQualified(dir))
            return Results.Json(new { ok = false, error = $"the {label} folder must be a full path" }, json, statusCode: 400);
        if (File.Exists(dir))
            return Results.Json(new { ok = false, error = $"{dir} is a file, not a folder" }, json, statusCode: 400);
        if (!Directory.Exists(dir) && !Directory.Exists(Path.GetDirectoryName(Path.GetFullPath(dir))))
            return Results.Json(new { ok = false, error = $"{Path.GetDirectoryName(Path.GetFullPath(dir))} does not exist" }, json, statusCode: 400);
    }

    projectsFile.AddProject(name, bugs.Length > 0 ? bugs : null, backlog.Length > 0 ? backlog : null);
    app.Logger.LogInformation("BugDesk: added project {name} to {file}", name, projectsFile.Path);
    return Results.Json(ProjectsPayload(), json);
});

app.MapDelete("/api/projects/{name}", (string name) =>
{
    var def = projectsFile.Current.Projects.FirstOrDefault(d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase));
    if (def is null)
        return Results.Json(new { ok = false, error = $"{name} is not in {projectsFile.Path}" }, json, statusCode: 404);
    if (projectsFile.Current.Projects.Count == 1 && stores.Transient is null)
        return Results.Json(new { ok = false, error = "that is the only project — add another before removing it" }, json, statusCode: 409);
    projectsFile.RemoveProject(def.Name);
    app.Logger.LogInformation("BugDesk: removed project {name} from {file}", def.Name, projectsFile.Path);
    return Results.Json(ProjectsPayload(), json);
});

// ---- The shared roster -----------------------------------------------------
// Managed from Settings, and by the /bugs and /backlog skills, which can add
// the people they find in the git history.
app.MapGet("/api/project", () => Results.Json(new
{
    ok = true,
    path = Req.Store.Project.Path,
    config = Req.Store.Project.Document(),
    assignees = Req.Store.Project.Assignees(),
}, json));

app.MapPost("/api/project/collaborators", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    if (!body.TryGetValue("collaborators", out var list) || list.ValueKind != JsonValueKind.Array)
        return Results.Json(new { ok = false, error = "collaborators array required" }, json, statusCode: 400);
    var saved = Req.Store.Project.SetCollaborators(JsonNode.Parse(list.GetRawText())!.AsArray());
    return Results.Json(new { ok = true, collaborators = saved, assignees = Req.Store.Project.Assignees() }, json);
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
    var saved = Req.Store.Project.Upsert(name, agent);
    return Results.Json(new { ok = true, collaborator = saved, assignees = Req.Store.Project.Assignees() }, json);
});

// The UI's own preference bag, stored in the profile so it follows the person
// rather than the browser (localStorage does not survive a different machine,
// and BugDesk is a tool you run from wherever the repo is checked out).
app.MapGet("/api/user/settings", () =>
    Results.Json(new { ok = true, settings = Req.Store.Users.Settings() }, json));

app.MapPost("/api/user/settings", async (HttpRequest req) =>
{
    if (JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync()) is not JsonObject patch)
        return Results.Json(new { ok = false, error = "expected a JSON object of settings" }, json, statusCode: 400);
    Req.Store.Users.MergeSettings(patch);
    return Results.Json(new { ok = true, settings = Req.Store.Users.Settings() }, json);
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
app.MapGet("/api/filters", () => Results.Json(new { ok = true, filters = Req.Store.Users.Filters() }, json));

app.MapPost("/api/filters", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    if (!body.TryGetValue("filters", out var list) || list.ValueKind != JsonValueKind.Array)
        return Results.Json(new { ok = false, error = "filters array required" }, json, statusCode: 400);
    if (Req.Store.Users.ActiveSlug is null)
        return Results.Json(new { ok = false, error = "no user profile yet — set a name first" }, json, statusCode: 409);
    Req.Store.Users.SetFilters(JsonNode.Parse(list.GetRawText())!.AsArray());
    return Results.Json(new { ok = true, filters = Req.Store.Users.Filters() }, json);
});

// ---- Workspace layout -----------------------------------------------------
// @flexdesk/host's state capability calls these two by name (see
// createPywebviewHost in the FlexDesk package). They once fell through to a
// permissive catch-all that answered {ok:true} to a READ — so the WM received the
// object `{ok:true}` where a saved layout should have been and every tile
// arrangement was lost on reload. That catch-all is gone (see the end of the
// endpoint list). They are per-user, like the filters.
app.MapPost("/api/workspace_state_read", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var path = body.TryGetValue("path", out var p) ? p.GetString() ?? "" : "";
    return Results.Json(new { ok = true, result = Req.Store.Users.ReadState(path) }, json);
});

app.MapPost("/api/workspace_state_write", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var path = body.TryGetValue("path", out var p) ? p.GetString() ?? "" : "";
    var data = body.TryGetValue("data", out var d) ? d.GetString() ?? "" : "";
    var wrote = Req.Store.Users.WriteState(path, data);
    return Results.Json(new { ok = true, result = new { ok = wrote } }, json);
});

// ---- Live updates: the stream ---------------------------------------------
// One long-lived response per open browser.
app.MapGet("/api/events", async (HttpContext http, CancellationToken ct) =>
{
    http.Response.Headers.ContentType = "text/event-stream";
    http.Response.Headers.CacheControl = "no-cache, no-transform";
    // Tells nginx and friends not to buffer; without it the stream is invisible
    // behind a reverse proxy until something flushes a whole buffer's worth.
    http.Response.Headers["X-Accel-Buffering"] = "no";

    var channel = Req.Store.Watcher.Subscribe();
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
    finally { Req.Store.Watcher.Unsubscribe(channel); }
});

// No catch-all. There used to be one here that answered every unhandled /api call
// with {ok:true, result:{ok:true}}, kept so the simulator's shell could boot
// against calls BugDesk never implemented (app_version, project_current, …). That
// shell is gone, and what the catch-all actually did by then was hide faults: an
// unimplemented call looked successful, so a caller that should have taken its
// fallback reported success instead — CSV export announced files it never wrote.
// An unknown route is now a plain 404, which is what it is.

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

/// <summary>
/// The value of one <see cref="ValueFlags"/> flag, or null when it is absent.
/// Last occurrence wins, matching how a shell reader expects a repeated flag to
/// behave, and both spellings are accepted because both get typed.
/// </summary>
static string? ArgValue(string[] argv, string flag)
{
    string? found = null;
    for (var i = 0; i < argv.Length; i++)
    {
        if (argv[i].StartsWith(flag + "=", StringComparison.OrdinalIgnoreCase))
            found = argv[i][(flag.Length + 1)..];
        else if (string.Equals(argv[i], flag, StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length)
            found = argv[i + 1];
    }
    return string.IsNullOrWhiteSpace(found) ? null : found.Trim();
}

/// <summary>
/// BugDesk's own flags, removed before the generic host parses the rest.
/// <para>
/// A loop rather than a Where, because a value flag written in its SPACE form
/// is two tokens and both have to go. Leaving the value behind hands the host a
/// bare path it reads as a positional argument, and leaving a bare `--tracker`
/// behind makes the command-line configuration provider throw before a line of
/// this file runs — it wants `--key=value` or `--key value` and nothing else.
/// </para>
/// </summary>
static string[] HostArgs(string[] argv)
{
    // BugDesk's own flags that take a value: `--flag=value` or `--flag value`.
    string[] valueFlags = { "--project", "--bugs-dir", "--backlog-dir" };
    var kept = new List<string>();
    for (var i = 0; i < argv.Length; i++)
    {
        var a = argv[i];
        if (a is "--tracker" or "--bugs") continue;
        if (a.StartsWith("--mode=", StringComparison.OrdinalIgnoreCase)) continue;
        var value = valueFlags.FirstOrDefault(f =>
            a.StartsWith(f + "=", StringComparison.OrdinalIgnoreCase)
            || string.Equals(a, f, StringComparison.OrdinalIgnoreCase));
        if (value is not null)
        {
            // The space form eats the token after it as well.
            if (string.Equals(a, value, StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length) i++;
            continue;
        }
        kept.Add(a);
    }
    return kept.ToArray();
}

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
static string ResolveTrackerBase(string[] argv) =>
    EnsureDir(Path.Combine(TrackerRoot(), ResolveTrackerProject(argv)));

/// <summary>The folder trackers live under: BUGDESK_TRACKER_HOME, else
/// %APPDATA%\BugDesk on Windows, else ~/.bugdesk.</summary>
static string TrackerRoot()
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
    return Path.GetFullPath(root);
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
// `--bugs-dir` beats BUGDESK_BUGS beats the default, and the same shape for the
// backlog. The flag wins for the same reason `--tracker` beats BUGDESK_MODE: it
// is the more local statement of intent, typed for this one run, while the
// variable may have been exported into the shell hours ago and forgotten.
static string ResolveBugsDir(string contentRoot, string[] argv)
{
    var flag = ArgValue(argv, "--bugs-dir");
    if (flag is not null) return Path.GetFullPath(flag);
    var env = Environment.GetEnvironmentVariable("BUGDESK_BUGS");
    if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
    // Self-contained default: a top-level bugs/ directory alongside server/ and
    // ui/. Created on first run (see attachDir above, whose CreateDirectory
    // call also creates this whole parent chain). Point --bugs-dir or
    // BUGDESK_BUGS elsewhere — e.g. a bugs/ folder tracked inside your own
    // project's repo — to use a different store.
    return Path.GetFullPath(Path.Combine(contentRoot, "..", "bugs"));
}

// The backlog store sits BESIDE the bug store rather than under a path of its
// own: pointing --bugs-dir at a project brings that project's backlog with it,
// which is almost always what you want. --backlog-dir / BUGDESK_BACKLOG
// overrides for the rest. Not created here: a store's folders are made when the
// store is first opened (StoreRegistry).
static string ResolveBacklogPath(string bugsDir, string[] argv)
{
    var flag = ArgValue(argv, "--backlog-dir");
    var env = Environment.GetEnvironmentVariable("BUGDESK_BACKLOG");
    return flag is not null ? Path.GetFullPath(flag)
        : !string.IsNullOrEmpty(env) ? Path.GetFullPath(env)
        : Path.GetFullPath(Path.Combine(bugsDir, "..", "backlog"));
}

/// <summary>The projects.toml a first run writes: the store BugDesk was started
/// on as the first project, and the rest of the format as comments to copy.</summary>
static string SeedProjectsToml(string name, string bugsDir, string backlogDir, string? trackerPath)
{
    static string Lit(string s) => s.Contains('\'') ? $"\"{s.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"" : $"'{s}'";
    var key = name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ? name : Lit(name);
    return $$"""
        # BugDesk projects — which stores this BugDesk serves, and where the global
        # tracker lives. Edit freely: BugDesk re-reads this file whenever it changes.
        # Paths are absolute or relative to this file; single quotes keep Windows
        # backslashes exactly as typed.
        #
        # [user]              who you are — one name in every project and the tracker
        # name = "you"
        #
        # [tracker]           the one global tracker (TicketDesk). Without it, no Tracker chip.
        # path = '{{Path.Combine(TrackerRoot(), "tracker")}}'
        # enabled = false     keep the path, but hide the Tracker section
        #
        # [projects.NAME]     a project: its bug store and/or its backlog — either may
        # bugs    = 'C:\path\to\repo\bugs'      be left out, and that page is then
        # backlog = 'C:\path\to\repo\backlog'   not offered for the project.

        [projects.{{key}}]
        bugs = {{Lit(bugsDir)}}
        backlog = {{Lit(backlogDir)}}
        {{(trackerPath is null ? "" : $"\n[tracker]\npath = {Lit(trackerPath)}\n")}}
        """.Replace("\r\n", "\n");
}

static bool SamePath(string a, string b) =>
    string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'),
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

/// <summary>The content type of an image BugDesk serves as an attachment, or null
/// for anything else — attachments are images, never arbitrary blobs.</summary>
static string? ImageContentType(string name) => Path.GetExtension(name).ToLowerInvariant() switch
{
    ".png" => "image/png",
    ".jpg" or ".jpeg" => "image/jpeg",
    ".gif" => "image/gif",
    ".webp" => "image/webp",
    ".svg" => "image/svg+xml",
    ".avif" => "image/avif",
    _ => null,
};

/// <summary>An API refusal, in the shape every endpoint answers with.</summary>
static Task Fail(HttpContext http, int status, string error)
{
    http.Response.StatusCode = status;
    return http.Response.WriteAsJsonAsync(new { ok = false, error });
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
        comments = item.Comments, history = item.History, children = childCount,
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
