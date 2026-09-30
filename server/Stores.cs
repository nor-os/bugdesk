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

    /// <summary>Every record write goes through here, so the watcher can tell our
    /// own echo from a change somebody else made.</summary>
    public async Task WriteRecord(string path, string text)
    {
        await File.WriteAllTextAsync(path, text);
        Watcher.Note(path, text);
    }

    public void Dispose() => Watcher.Dispose();
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

    public Store? Project(string name)
    {
        var def = Definitions.FirstOrDefault(d => Same(d.Name, name));
        return def is null ? null : Get("p:" + def.Name, Plan(def));
    }

    public Store? Tracker()
    {
        var path = TrackerPath;
        return path is null ? null : Get("t:", PlanTracker(path));
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
        return new Store
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
