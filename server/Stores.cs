using System.Text.Json;
using System.Text.Json.Nodes;

/// <summary>
/// One set of records BugDesk serves: a PROJECT (a bug store and/or a backlog,
/// usually inside a repo) or the TRACKER (the one global store of tickets, which
/// belongs to no project). Each carries everything a request against it needs —
/// the folders, whose profile is active there, the shared roster, the file
/// watcher that turns outside edits into live updates.
///
/// <para>
/// A request is bound to exactly one store by its URL — <c>/p/&lt;name&gt;/…</c>
/// for a project, <c>/t/…</c> for the tracker — and the endpoints reach it
/// through <see cref="Req.Store"/>. See the routing middleware in Program.cs.
/// </para>
/// </summary>
sealed class Store : IDisposable
{
    public required string Name { get; init; }
    /// <summary>"project" or "tracker".</summary>
    public required string Kind { get; init; }
    /// <summary>The bug store, or "" when this store has none.</summary>
    public required string BugsDir { get; init; }
    /// <summary>The backlog (a project) or the tickets (the tracker), or "".</summary>
    public required string BacklogDir { get; init; }
    public required string AttachDir { get; init; }
    public required string ConfigDir { get; init; }
    public required UserStore Users { get; init; }
    public required ProjectConfig Project { get; init; }
    public required StoreWatcher Watcher { get; init; }
    /// <summary>The folders this store was built from; a different signature for
    /// the same name means projects.toml changed and the store must be rebuilt.</summary>
    public required string Signature { get; init; }

    public bool IsTracker => Kind == "tracker";
    public bool HasBugs => BugsDir.Length > 0;
    public bool HasBacklog => BacklogDir.Length > 0;
    /// <summary>In the tracker nobody has an assistant — see
    /// <see cref="ProjectConfig.AgentsAssignable"/>.</summary>
    public bool AgentsAssignable => !IsTracker;
    /// <summary>Where this store's pages and API live, with a trailing slash.</summary>
    public string UrlBase => IsTracker ? "/t/" : $"/p/{Uri.EscapeDataString(Name)}/";

    /// <summary>Git for this store's record files (GitService.cs), found once.</summary>
    public GitService Git => _git ??= new GitService(BugsDir, BacklogDir) { ConfigDir = ConfigDir };
    GitService? _git;

    /// <summary>Look for the repository again when there was none — somebody may
    /// have run <c>git init</c> since, here (Initialize git) or by hand — or when
    /// the one found has gone (its <c>.git</c> removed or moved).</summary>
    public void RefreshGit()
    {
        if (_git is { Enabled: false } or { StillThere: false }) _git = null;
    }

    /// <summary>Where Initialize git puts a repository (STORY-0049): the folder
    /// the store's folders sit in — a tracker's base, a project's root — as
    /// StoreRegistry.Plan works it out.</summary>
    public string GitHome => Path.GetDirectoryName(Path.GetFullPath(HasBugs ? BugsDir : HasBacklog ? BacklogDir : ConfigDir))!;

    /// <summary>
    /// Every record write goes through here, so the watcher can tell our own echo
    /// from a change somebody else made — and so "commit after save" (Settings ›
    /// Saving and git) has one place to happen: the record file, by path, as
    /// <c>BUG-0042: record edits from the UI</c>, the skills' format. A write that
    /// should not commit yet (an auto-save between edits) passes
    /// <paramref name="commit"/> false. A failed commit never fails the save:
    /// the file is written, and the Changes pane shows what is left.
    /// </summary>
    public async Task WriteRecord(string path, string text, bool commit = true)
    {
        await File.WriteAllTextAsync(path, text);
        Watcher.Note(path, text);
        if (commit) CommitAfterSave(new[] { path });
    }

    /// <summary>Commit these record files if the project asks for it, and push
    /// after if it asks for that too. Returns git's message on failure, else null.</summary>
    public string? CommitAfterSave(IEnumerable<string> paths)
    {
        var settings = GitSettings.Parse(Project.Document()["git"]);
        if (!settings.CommitAfterSave || !Git.Enabled) return null;
        var files = paths.Where(Git.IsRecord).ToList();
        if (files.Count == 0) return null;
        var refs = string.Join(", ", files.Select(f => Path.GetFileNameWithoutExtension(f)));
        var error = Git.Commit(files, $"{refs}: record edits from the UI");
        if (error is null && settings.PushAfterCommit) Git.PushInBackground(() => Watcher.Broadcast("git", "{}"));
        Watcher.Broadcast("git", "{}");
        return error;
    }

    public void Dispose()
    {
        Records.Release(this);
        Watcher.Dispose();
    }
}

/// <summary>The store the current request is addressed to. Set by the routing
/// middleware before the endpoint runs; an AsyncLocal, so it follows the request
/// through every await and never leaks into another one.</summary>
static class Req
{
    static readonly AsyncLocal<Store?> _current = new();

    public static Store Store =>
        _current.Value ?? throw new InvalidOperationException("this request is not addressed to a store");

    public static Store? Maybe
    {
        get => _current.Value;
        set => _current.Value = value;
    }
}

/// <summary>
/// Builds stores from <see cref="ProjectsFile"/> on first use and keeps them
/// while their folders stay the same. The file is re-read on every lookup, so a
/// project added by hand is there on the next request, and one whose paths were
/// edited is rebuilt rather than served from its old folders.
/// </summary>
sealed class StoreRegistry
{
    readonly object _gate = new();
    readonly Dictionary<string, Store> _stores = new(StringComparer.OrdinalIgnoreCase);
    readonly ProjectsFile _file;
    readonly ILogger _log;
    readonly string? _envUser, _envHuman, _envAgent;
    readonly string _lastUsedPath;
    readonly string _stateDir;

    /// <summary>A project named on the command line (<c>--bugs-dir</c> and friends)
    /// that projects.toml does not list. Served for this run only, never written.</summary>
    public ProjectsFile.ProjectDef? Transient { get; set; }

    /// <summary>Standalone TicketDesk (<c>--tracker</c>) naming its tracker on the
    /// command line, or finding none in projects.toml: the base to use instead.</summary>
    public string? TrackerOverride { get; set; }

    /// <summary>The project a bare address opens when the command line named one.</summary>
    public string? Preferred { get; set; }

    public ProjectsFile File => _file;

    public StoreRegistry(ProjectsFile file, ILogger log, string stateDir)
    {
        _file = file;
        _log = log;
        _envUser = Env("BUGDESK_USER");
        _envHuman = Env("BUGDESK_HUMAN");
        _envAgent = Env("BUGDESK_AGENT");
        _stateDir = stateDir;
        _lastUsedPath = Path.Combine(stateDir, "last-project");
    }

    /// <summary>Every project, in file order — the transient one first.</summary>
    public IReadOnlyList<ProjectsFile.ProjectDef> Definitions
    {
        get
        {
            var defs = _file.Current.Projects;
            return Transient is { } t && !defs.Any(d => Same(d.Name, t.Name))
                ? defs.Prepend(t).ToList()
                : defs;
        }
    }

    public string? TrackerPath =>
        TrackerOverride ?? (_file.Current.TrackerPath is { } p ? _file.Resolve(p) : null);

    /// <summary>Standalone TicketDesk: the tracker is the whole app, so
    /// <c>[tracker] enabled = false</c> — which hides the Tracker SECTION of
    /// project pages — does not apply to it.</summary>
    public bool Standalone { get; set; }

    /// <summary>Whether there is a tracker to serve: a path, and not switched
    /// off in projects.toml.</summary>
    public bool TrackerAvailable => TrackerPath is not null && (Standalone || _file.Current.TrackerEnabled);

    public Store? Project(string name)
    {
        var def = Definitions.FirstOrDefault(d => Same(d.Name, name));
        return def is null ? null : Get("p:" + def.Name, Plan(def));
    }

    public Store? Tracker()
    {
        var path = TrackerPath;
        return path is null || !TrackerAvailable ? null : Get("t:", PlanTracker(path));
    }

    /// <summary>The project a bare address opens: the command line's when it
    /// named one, else the one used last, else the first in the file.</summary>
    public ProjectsFile.ProjectDef? DefaultProject
    {
        get
        {
            var defs = Definitions;
            var last = ReadLastUsed();
            return defs.FirstOrDefault(d => Same(d.Name, Preferred ?? ""))
                ?? defs.FirstOrDefault(d => Same(d.Name, last ?? ""))
                ?? defs.FirstOrDefault();
        }
    }

    /// <summary>Every store built so far — what a content-addressed attachment is
    /// looked up in when the request names no store.</summary>
    public List<Store> Open()
    {
        lock (_gate) return _stores.Values.ToList();
    }

    public void MarkUsed(string name)
    {
        try
        {
            if (ReadLastUsed() == name) return;
            Directory.CreateDirectory(Path.GetDirectoryName(_lastUsedPath)!);
            System.IO.File.WriteAllText(_lastUsedPath, name);
        }
        catch (IOException ex) { _log.LogWarning(ex, "BugDesk: could not remember the last project"); }
    }

    string? ReadLastUsed()
    {
        try { return System.IO.File.Exists(_lastUsedPath) ? System.IO.File.ReadAllText(_lastUsedPath).Trim() : null; }
        catch (IOException) { return null; }
    }

    /* ── personal state that is not a project's ─────────────────────────
     * Some of what is yours belongs to no single project: your personal
     * dashboards read the tracker and every project alike, so keeping them in
     * one project's .bugdesk/state-<slug>/ showed them in that project only.
     * They live in BugDesk's own state directory instead (beside last-project,
     * one folder per profile), which every project and the tracker share.
     */

    /// <summary>Files that moved here from the stores' state folders, and are
    /// folded in from there on read (see <see cref="FoldLegacyDashboards"/>).</summary>
    const string DashboardsFile = "dashboards.json";

    public string? ReadPersonal(string? slug, string path)
    {
        var file = PersonalPath(slug, path);
        if (file is null) return null;
        lock (_gate)
        {
            if (Path.GetFileName(file) == DashboardsFile) FoldLegacyDashboards(slug!, file);
            return System.IO.File.Exists(file) ? System.IO.File.ReadAllText(file) : null;
        }
    }

    public bool WritePersonal(string? slug, string path, string data)
    {
        var file = PersonalPath(slug, path);
        if (file is null) return false;
        lock (_gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            System.IO.File.WriteAllText(file, data);
        }
        return true;
    }

    /// <summary>Only the file name is used, as in UserStore.ReadState, so
    /// nothing a request sends can leave the profile's folder.</summary>
    string? PersonalPath(string? slug, string path)
    {
        if (slug is null) return null;                          // nameless run — nothing to key on
        var name = Path.GetFileName(path.Replace('\\', '/'));
        if (string.IsNullOrWhiteSpace(name) || name is "." or "..") return null;
        return Path.Combine(_stateDir, $"state-{slug}", name);
    }

    /* ── personal switches (STORY-0043) ─────────────────────────────────
     * Which sections YOU see, kept beside your personal dashboards and for the
     * same reason: the Tracker is the same in every project, so switching it
     * off in one project and finding it on in the next would be two answers to
     * one question. Only `tracker` so far: false hides the Tracker section of
     * every project page, on top of projects.toml's machine-wide switch.
     */
    const string PreferencesFile = "preferences.json";

    public JsonObject Preferences(string? slug)
    {
        var text = ReadPersonal(slug, PreferencesFile);
        if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
        try { return JsonNode.Parse(text) as JsonObject ?? new JsonObject(); }
        catch (JsonException) { return new JsonObject(); }
    }

    /// <summary>Lays <paramref name="patch"/> over the saved preferences; a
    /// <c>null</c> value removes the key, back to the default. False when
    /// there is no profile to save them to.</summary>
    public bool MergePreferences(string? slug, JsonObject patch)
    {
        if (PersonalPath(slug, PreferencesFile) is null) return false;
        lock (_gate)
        {
            var doc = Preferences(slug);
            foreach (var (key, value) in patch)
            {
                if (value is null) doc.Remove(key);
                else doc[key] = value.DeepClone();
            }
            return WritePersonal(slug, PreferencesFile, doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    /// <summary>Whether this person shows the Tracker section: yes unless they
    /// switched it off. Says nothing about whether there is a tracker at all
    /// (<see cref="TrackerAvailable"/>).</summary>
    public bool TrackerShown(string? slug) =>
        Preferences(slug)["tracker"] is not JsonValue v || !v.TryGetValue<bool>(out var on) || on;

    /// <summary>
    /// Personal dashboards used to be kept per store. Every project's and the
    /// tracker's old file is merged into the shared one — entries whose id is
    /// already there are left out, so a dashboard copied into two stores comes
    /// over once — and renamed aside, so it is folded in exactly once and stays
    /// on disk. A file that does not parse, on either side, is left alone.
    /// </summary>
    void FoldLegacyDashboards(string slug, string file)
    {
        var configs = Definitions.Select(d => Plan(d).Config).ToList();
        if (TrackerPath is { } t) configs.Add(PlanTracker(t).Config);
        var legacy = configs.Select(c => Path.Combine(c, $"state-{slug}", DashboardsFile))
            .Distinct(StringComparer.OrdinalIgnoreCase).Where(System.IO.File.Exists).ToList();
        if (legacy.Count == 0) return;

        JsonObject doc;
        try
        {
            doc = System.IO.File.Exists(file)
                ? JsonNode.Parse(System.IO.File.ReadAllText(file)) as JsonObject ?? throw new JsonException()
                : new JsonObject { ["version"] = 1, ["dashboards"] = new JsonArray() };
            if (doc["dashboards"] is not JsonArray) throw new JsonException();
        }
        catch (JsonException) { return; }
        var list = (JsonArray)doc["dashboards"]!;

        foreach (var old in legacy)
        {
            try
            {
                if (JsonNode.Parse(System.IO.File.ReadAllText(old))?["dashboards"] is not JsonArray entries) continue;
                foreach (var e in entries)
                {
                    var id = (e as JsonObject)?["id"]?.GetValueKind() == JsonValueKind.String ? (string?)e!["id"] : null;
                    if (id is not null && list.Any(x => (x as JsonObject)?["id"]?.GetValueKind() == JsonValueKind.String
                                                        && (string?)x!["id"] == id)) continue;
                    list.Add(e?.DeepClone());
                }
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                System.IO.File.WriteAllText(file, $"{doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true })}\n");
                System.IO.File.Move(old, old + ".migrated", overwrite: true);
                _log.LogInformation("BugDesk: personal dashboards in {old} moved to {file}", old, file);
            }
            catch (JsonException) { /* left where it is, for anyone who wants to look */ }
            catch (IOException ex) { _log.LogWarning(ex, "BugDesk: could not move personal dashboards from {old}", old); }
        }
    }

    /// <summary>Where a store's files are — cheap to work out on every request,
    /// unlike the store itself, which opens file watchers.</summary>
    sealed record Spec(string Name, string Kind, string Bugs, string Backlog, string Attach, string Config,
                       string Roster)
    {
        public string Signature => string.Join('|', Kind, Bugs, Backlog, Attach, Config, Roster);
    }

    Store Get(string key, Spec spec)
    {
        lock (_gate)
        {
            if (_stores.TryGetValue(key, out var existing))
            {
                if (existing.Signature == spec.Signature) { Sync(existing); return existing; }
                existing.Dispose();
                _log.LogInformation("BugDesk: {name}'s folders changed in projects.toml — reopened", existing.Name);
            }
            var fresh = Assemble(spec);
            _stores[key] = fresh;
            _log.LogInformation("BugDesk: opened {kind} {name}: bugs={bugs} backlog={backlog} config={config}",
                fresh.Kind, fresh.Name, fresh.BugsDir.Length > 0 ? fresh.BugsDir : "(none)",
                fresh.BacklogDir.Length > 0 ? fresh.BacklogDir : "(none)", fresh.ConfigDir);
            Sync(fresh);
            return fresh;
        }
    }

    /// <summary>
    /// ONE NAME EVERYWHERE. <c>[user]</c> in projects.toml is who you are, in
    /// every project and in the tracker; each store's own profile follows it.
    /// The profiles still exist per store — they hold that store's filters and
    /// layout, and the /bugs and /backlog skills read the active one to know who
    /// the human is — but none of them decides the name any more.
    ///
    /// When the file names nobody yet and this store already has a profile (every
    /// checkout from before projects.toml), that name is adopted into the file
    /// rather than asked for again.
    /// </summary>
    void Sync(Store s)
    {
        if (_envUser is not null) return;   // a per-process override: leave it alone
        var model = _file.Current;
        var name = model.UserName;
        if (name is null)
        {
            if (s.Users.Configured && _file.Exists) _file.SetUser(s.Users.HumanAuthor, null);
            return;
        }
        var agent = model.AgentName ?? (s.AgentsAssignable ? ProjectConfig.AgentNameFor(name) : null);
        if (s.Users.ActiveSlug != UserStore.SlugOf(name) || s.Users.HumanAuthor != name
            || (agent is not null && s.Users.AgentAuthor != agent))
            s.Users.SelectOrCreate(name, agent);
        if (!s.Project.Assignees().Any(a => Same(a, name))) s.Project.Upsert(name, agent);
    }

    Spec Plan(ProjectsFile.ProjectDef def)
    {
        var bugs = def.Bugs is { } b ? _file.Resolve(b) : "";
        var backlog = def.Backlog is { } k ? _file.Resolve(k) : "";
        // The repo root, as far as BugDesk can tell: the folder the stores sit in.
        var root = Path.GetDirectoryName(bugs.Length > 0 ? bugs : backlog.Length > 0 ? backlog : _file.Path)!;
        var config = def.Config is { } c ? _file.Resolve(c) : Path.Combine(root, ".bugdesk");
        var attach = def.Attachments is { } a ? _file.Resolve(a)
            : Path.Combine(bugs.Length > 0 ? bugs : backlog.Length > 0 ? backlog : config, "attachments");
        return new Spec(def.Name, "project", bugs, backlog, attach, config, Roster(root, config));
    }

    static Spec PlanTracker(string basePath)
    {
        var @base = Path.GetFullPath(basePath);
        var config = Path.Combine(@base, "config");
        return new Spec("tracker", "tracker", "", Path.Combine(@base, "tickets"),
            Path.Combine(@base, "attachments"), config, Roster(@base, config));
    }

    Store Assemble(Spec spec)
    {
        var tracker = spec.Kind == "tracker";
        // A tracker's base is ours to lay out, so its folders are simply made;
        // a project's are made only where their parent already exists.
        if (tracker) Directory.CreateDirectory(spec.Backlog);
        else { Ensure(spec.Bugs); Ensure(spec.Backlog); }
        Directory.CreateDirectory(spec.Attach);
        var store = new Store
        {
            Name = spec.Name,
            Kind = spec.Kind,
            BugsDir = spec.Bugs,
            BacklogDir = spec.Backlog,
            AttachDir = spec.Attach,
            ConfigDir = spec.Config,
            Users = new UserStore(spec.Config, _envUser, _envHuman, _envAgent, deriveAgent: !tracker),
            Project = new ProjectConfig(spec.Roster, agentsAssignable: !tracker),
            Watcher = new StoreWatcher(spec.Bugs, spec.Backlog, spec.Roster, _log),
            Signature = spec.Signature,
        };
        Records.Attach(store);
        return store;
    }

    /// <summary>
    /// The shared roster — COMMITTED, unlike everything else in the config dir.
    /// See ProjectConfig.cs.
    ///
    /// <para>
    /// It lives at <c>.bugdesk/project.json</c>, in the same directory as the
    /// per-user files, and <c>.bugdesk/.gitignore</c> ignores everything in there
    /// EXCEPT this file (see UserStore.EnsureGitIgnore). A ROOT
    /// <c>bugdesk.json</c> from before that move still wins when one exists:
    /// repos created earlier have it committed, and silently reading a different,
    /// empty file would look exactly like BugDesk losing the roster.
    /// </para>
    /// </summary>
    static string Roster(string root, string config)
    {
        var legacy = Path.Combine(root, "bugdesk.json");
        return System.IO.File.Exists(legacy) ? legacy : Path.Combine(config, UserStore.SharedFileName);
    }

    /// <summary>A store folder, created when its parent exists — a new project's
    /// empty backlog is a normal thing to start — but never a whole chain of
    /// folders conjured from a mistyped path.</summary>
    static void Ensure(string dir)
    {
        if (dir.Length > 0 && !Directory.Exists(dir) && Directory.Exists(Path.GetDirectoryName(dir)))
            Directory.CreateDirectory(dir);
    }

    static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    static string? Env(string name) =>
        Environment.GetEnvironmentVariable(name) is { } v && v.Trim().Length > 0 ? v.Trim() : null;
}
