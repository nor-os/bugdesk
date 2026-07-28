using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// BugDesk bridge: serves the FlexDesk UI and exposes the markdown bug store
// (SharpGenerals/bugs/*.md) as JSON. The markdown files are the source of truth;
// this process only reads and writes them.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// ---- Locate the bug store -------------------------------------------------
string bugsDir = ResolveBugsDir(app.Environment.ContentRootPath);
string uiDir = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "ui"));
app.Logger.LogInformation("BugDesk: bugs={bugs} ui={ui}", bugsDir, uiDir);

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
// part of the bug report, and keeping it beside the .md means the two travel
// together in git rather than rotting as a dead link.
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
            text = SetFrontmatter(text, key, v.ValueKind == JsonValueKind.String ? v.GetString()! : v.ToString());
        else if (key is "labels" or "links" && v.ValueKind == JsonValueKind.Array)
            text = SetFrontmatter(text, key, "[" + string.Join(", ", v.EnumerateArray().Select(e => e.GetString())) + "]");
    }
    text = SetFrontmatter(text, "updated", Today());
    await File.WriteAllTextAsync(path, text);
    return Results.Json(new { ok = true, bug = LoadOne(bugsDir, id) }, json);
});

app.MapPost("/api/bugs/{id:int}/comments", async (int id, HttpRequest req) =>
{
    var path = BugPath(bugsDir, id);
    if (!File.Exists(path)) return Results.Json(new { ok = false, error = "not found" }, json, statusCode: 404);
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    var author = body.TryGetValue("author", out var a) ? a.GetString() : "norman";
    var comment = body.TryGetValue("body", out var b) ? b.GetString() : "";
    if (string.IsNullOrWhiteSpace(comment)) return Results.Json(new { ok = false, error = "empty comment" }, json, statusCode: 400);

    var text = (await File.ReadAllTextAsync(path)).TrimEnd() + "\n\n";
    if (!text.Contains("## Comments")) text += "## Comments\n\n";
    text += $"### {Today()} · {author}\n\n{comment!.Trim()}\n";
    text = SetFrontmatter(text, "updated", Today());
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
    sb.Append($"title: \"{title.Replace("\"", "'")}\"\n");
    sb.Append("status: open\n");
    sb.Append($"severity: {Get("severity", "medium")}\n");
    sb.Append($"type: {Get("type", "bug")}\n");
    sb.Append($"subsystem: {Get("subsystem", "unsorted")}\n");
    sb.Append($"assignee: {Get("assignee", "norman")}\n");
    sb.Append($"labels: [{labels}]\n");
    sb.Append($"links: [{links}]\n");
    sb.Append($"created: {Today()}\n");
    sb.Append($"updated: {Today()}\n");
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

// ---- Custom queue filters -------------------------------------------------
// The UI authors filter expressions (an AST); the bridge only stores the JSON
// array verbatim — their shape is the UI's business, so nothing here parses it.
// POST is a FULL REPLACE of the list, which is what the UI's store does anyway.
string filtersPath = Path.Combine(ResolveStateDir(app.Environment.ContentRootPath), "filters.json");
app.Logger.LogInformation("BugDesk: filters={filters}", filtersPath);

app.MapGet("/api/filters", () => Results.Json(new { ok = true, filters = LoadFilters(filtersPath) }, json));

app.MapPost("/api/filters", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<Dictionary<string, JsonElement>>(req.Body, json) ?? new();
    if (!body.TryGetValue("filters", out var list) || list.ValueKind != JsonValueKind.Array)
        return Results.Json(new { ok = false, error = "filters array required" }, json, statusCode: 400);
    Directory.CreateDirectory(Path.GetDirectoryName(filtersPath)!);
    await File.WriteAllTextAsync(filtersPath, list.GetRawText());
    return Results.Json(new { ok = true, filters = LoadFilters(filtersPath) }, json);
});

// Permissive fallback for the EcoAgent/FlexDesk shell's bridge calls (app_version,
// app_get_platform, layout persistence, ...): anything not handled above returns
// {ok:true, result:{ok:true}} so the shell boots and renders its empty states,
// exactly as ticketdesk's Python bridge did. Specific /api routes above take
// precedence over this catch-all.
app.MapMethods("/api/{**rest}", new[] { "GET", "POST" },
    () => Results.Json(new { ok = true, result = new { ok = true } }, json));

app.Run();

// ---- helpers --------------------------------------------------------------
static string ResolveBugsDir(string contentRoot)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_BUGS");
    if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return Path.GetFullPath(env);
    var rel = Path.GetFullPath(Path.Combine(contentRoot, "..", "..", "SharpGenerals", "bugs"));
    if (Directory.Exists(rel)) return rel;
    return "/mnt/c/Users/Norman/repos/SharpGenerals/bugs";
}

// UI-owned state (custom filters, ...). Unlike the bug store this is created on
// demand — a fresh checkout has no state directory and must still serve GETs.
static string ResolveStateDir(string contentRoot)
{
    var env = Environment.GetEnvironmentVariable("BUGDESK_STATE");
    if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
    return Path.GetFullPath(Path.Combine(contentRoot, "state"));
}

// Missing file = no filters yet. Malformed file is NOT swallowed: it throws so
// the failure is visible instead of silently wiping the user's filters.
static List<JsonElement> LoadFilters(string path)
{
    if (!File.Exists(path)) return new();
    using var doc = JsonDocument.Parse(File.ReadAllText(path));
    return doc.RootElement.ValueKind == JsonValueKind.Array
        ? doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToList()
        : new();
}

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

static string Today() => DateTime.UtcNow.ToString("yyyy-MM-dd");
static string BugPath(string dir, int id) => Path.Combine(dir, $"BUG-{id:D4}.md");

static List<Bug> LoadAll(string dir) =>
    Directory.Exists(dir)
        ? Directory.EnumerateFiles(dir, "BUG-*.md").Select(Bug.Parse).Where(b => b != null).Select(b => b!).ToList()
        : new();

static Bug? LoadOne(string dir, int id)
{
    var p = BugPath(dir, id);
    return File.Exists(p) ? Bug.Parse(p) : null;
}

static string? GetFrontmatter(string text, string key)
{
    var m = new Regex($@"(?m)^{Regex.Escape(key)}:\s*(.*)$").Match(text);
    return m.Success ? m.Groups[1].Value.Trim().Trim('"') : null;
}

static string SetFrontmatter(string text, string key, string value)
{
    var rx = new Regex($@"(?m)^{Regex.Escape(key)}:.*$");
    if (rx.IsMatch(text)) return rx.Replace(text, $"{key}: {value}", 1);
    // insert before closing --- of frontmatter
    var idx = text.IndexOf("\n---", text.IndexOf("---") + 3, StringComparison.Ordinal);
    return idx < 0 ? text : text.Insert(idx, $"\n{key}: {value}");
}

// ---- model ----------------------------------------------------------------
record Comment(string Date, string Author, string Body);

class Bug
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Status { get; set; } = "open";
    public string Severity { get; set; } = "medium";
    public string Type { get; set; } = "bug";
    public string Subsystem { get; set; } = "unsorted";
    public string Assignee { get; set; } = "norman";
    public List<string> Labels { get; set; } = new();

    /// <summary>
    /// Relationships to other bugs, as "&lt;type&gt; &lt;id&gt;" tokens — e.g. "blocks 47".
    /// <para>
    /// Only the AUTHORED direction is ever stored. The inverse ("#47 is-blocked-by this") is
    /// derived by whoever is reading, so the two files can never drift out of agreement and
    /// removing a link only ever touches one file.
    /// </para>
    /// </summary>
    public List<string> Links { get; set; } = new();

    public string Created { get; set; } = "";
    public string Updated { get; set; } = "";
    public string Description { get; set; } = "";
    public List<Comment> Comments { get; set; } = new();

    // Lifecycle: open → investigation ⇄ testing → closed.
    public int Stage => Status switch
    {
        "open" => 0, "investigation" => 1, "testing" => 2, "closed" => 3, _ => 0
    };
    public int Pri => Severity switch
    {
        "crash" => 1, "high" => 2, "medium" => 3, "low" => 4, _ => 3
    };

    public object ToSummary() => new
    {
        id = Id, title = Title, status = Status, severity = Severity, type = Type,
        subsystem = Subsystem, assignee = Assignee, labels = Labels, links = Links,
        created = Created, updated = Updated, stage = Stage, pri = Pri,
        comments = Comments.Count,
        // Last comment's author/date (or null) so the UI can build a
        // "needs my reply" filter from the summary list alone.
        lastCommentAuthor = Comments.Count > 0 ? Comments[^1].Author : null,
        lastCommentDate = Comments.Count > 0 ? Comments[^1].Date : null
    };

    // "### 2026-07-27 · claude", optionally followed by a parenthetical note and/or the
    // _(imported)_ marker. The author stops at '(' deliberately: a header written as
    // "· claude (fixed)" used to parse its author as the whole string "claude (fixed)", which is
    // not "claude", so the bug silently vanished from the "Needs my reply" filter with nothing
    // anywhere reporting a problem. Authors are claude|norman per bugs/SCHEMA.md; anything after
    // the name is a note, not part of the identity.
    static readonly Regex CommentHdr = new(@"^###\s+(?<date>\S+)\s+·\s+(?<author>[^\r\n_(]+?)\s*(?:\([^)\r\n]*\))?\s*(?:_\(imported\)_)?\s*$", RegexOptions.Multiline);

    public static Bug? Parse(string path)
    {
        var text = File.ReadAllText(path);
        if (!text.StartsWith("---")) return null;
        var end = text.IndexOf("\n---", 3, StringComparison.Ordinal);
        if (end < 0) return null;
        var front = text.Substring(3, end - 3);
        var rest = text[(end + 4)..].TrimStart('\n');

        var bug = new Bug();
        foreach (var raw in front.Split('\n'))
        {
            var line = raw.Trim();
            var ci = line.IndexOf(':');
            if (ci <= 0) continue;
            var k = line[..ci].Trim().ToLowerInvariant();
            var val = line[(ci + 1)..].Trim().Trim('"');
            switch (k)
            {
                case "id": int.TryParse(val, out var id); bug.Id = id; break;
                case "title": bug.Title = val; break;
                case "status": bug.Status = val; break;
                case "severity": bug.Severity = val; break;
                case "type": bug.Type = val; break;
                case "subsystem": bug.Subsystem = val; break;
                case "assignee": bug.Assignee = val; break;
                case "created": bug.Created = val; break;
                case "updated": bug.Updated = val; break;
                case "labels":
                    val = val.Trim('[', ']');
                    bug.Labels = val.Length == 0 ? new() : val.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
                    break;
                case "links":
                    val = val.Trim('[', ']');
                    bug.Links = val.Length == 0 ? new() : val.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
                    break;
            }
        }

        // Split body into Description and Comments.
        var commentsIdx = rest.IndexOf("## Comments", StringComparison.Ordinal);
        var descBlock = commentsIdx >= 0 ? rest[..commentsIdx] : rest;
        bug.Description = StripLeadingHeading(descBlock, "## Description").Trim();

        if (commentsIdx >= 0)
        {
            var commentsBlock = rest[(commentsIdx + "## Comments".Length)..];
            var matches = CommentHdr.Matches(commentsBlock);
            for (int i = 0; i < matches.Count; i++)
            {
                var m = matches[i];
                var start = m.Index + m.Length;
                var stop = i + 1 < matches.Count ? matches[i + 1].Index : commentsBlock.Length;
                var body = commentsBlock[start..stop].Trim();
                bug.Comments.Add(new Comment(m.Groups["date"].Value, m.Groups["author"].Value.Trim(), body));
            }
        }
        return bug;
    }

    static string StripLeadingHeading(string s, string heading)
    {
        var i = s.IndexOf(heading, StringComparison.Ordinal);
        return i < 0 ? s : s[(i + heading.Length)..];
    }
}
