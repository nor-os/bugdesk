using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

/// <summary>
/// Per-user, git-ignored BugDesk configuration.
///
/// <para>
/// BugDesk's stores (<c>bugs/</c>, <c>backlog/</c>) are meant to be COMMITTED —
/// that is the whole point of markdown records. But "who am I", "which filters
/// have I saved" and "how is my workspace laid out" are the opposite: they are
/// per-person, and committing them means two people on the same repo overwrite
/// each other's identity on every pull. So they live beside the store in a
/// directory BugDesk creates and ignores on your behalf:
/// </para>
///
/// <code>
/// your-project/
///   bugs/BUG-0001.md          tracked
///   backlog/EPIC-0001.md      tracked
///   .bugdesk/
///     .gitignore              ignores everything here EXCEPT project.json, so
///                             the rule itself says which half is shared — and
///                             the project's own .gitignore still needs no edit
///     project.json            TRACKED — the collaborator roster (ProjectConfig)
///     active.json             which profile THIS checkout is using
///     user-alice.json         alice's name, filters and settings
///     user-bob.json           bob's
///     state-alice/            alice's workspace layout (desktops, tiles)
/// </code>
///
/// <para>
/// ONE directory, holding both halves, because two things at the project root
/// called <c>bugdesk.json</c> and <c>.bugdesk/</c> read as duplicates of each
/// other rather than as "the team's" and "yours". The split is real and it
/// matters; what was missing was anything on disk that said so. Now the
/// <c>.gitignore</c> does, at the exact point where the difference has an
/// effect. A root <c>bugdesk.json</c> is still read when one exists — see
/// <c>ResolveProjectConfig</c> — so no repo that predates this moves under
/// anyone's feet.
/// </para>
///
/// <para>
/// The first run has no profile, so <see cref="Configured"/> is false and the UI
/// asks for a name before it renders anything else (see
/// <c>ui/js/ticketdesk/first_run.js</c>). Everything after that is a reload of
/// the same file.
/// </para>
///
/// <para>
/// THE PROFILE WINS. Environment variables SEED an identity; they do not
/// override one. <c>BUGDESK_HUMAN</c>/<c>BUGDESK_AGENT</c> are used when there
/// is no profile yet — and a profile is written from them on the spot, which is
/// what suppresses the first-run prompt for a scripted deployment. From then on
/// the file is the answer, because the file is what the UI writes and what
/// <c>GET /api/config</c> reports to the skills.
/// </para>
///
/// <para>
/// It used to be the other way round, and there was no way out of it: with
/// <c>BUGDESK_HUMAN</c> exported in a shell profile, "change your name" wrote a
/// file the server then ignored on every boot, for ever. An environment
/// variable is how a process is STARTED; a config file is what the user
/// CHANGED, and the more recent, more deliberate statement has to be the one
/// that counts. The one thing an env var could do that the file cannot — pick a
/// different identity per process, for two people sharing one checkout — is
/// what <c>BUGDESK_USER</c> is for, and that still works: it selects a profile
/// for this process only, without rewriting <c>active.json</c>.
/// </para>
/// </summary>
class UserStore
{
    readonly object _gate = new();
    readonly string? _envUser, _envHuman, _envAgent;

    public string ConfigDir { get; }

    /// <summary>Slug of the profile in use, or null when there is none yet.</summary>
    public string? ActiveSlug { get; private set; }

    public UserStore(string configDir, string? envUser, string? envHuman, string? envAgent)
    {
        ConfigDir = configDir;
        _envUser = Blank(envUser) ? null : envUser!.Trim();
        _envHuman = Blank(envHuman) ? null : envHuman!.Trim();
        _envAgent = Blank(envAgent) ? null : envAgent!.Trim();

        Directory.CreateDirectory(ConfigDir);
        EnsureGitIgnore();

        // BUGDESK_USER names a profile for this process only — it must not
        // rewrite active.json, or one `BUGDESK_USER=bob ./run.sh` would silently
        // repoint the checkout's default.
        ActiveSlug = _envUser is not null
            ? SlugOf(_envUser)
            : ReadJson(ActivePath)?["user"]?.GetValue<string>();

        if (ActiveSlug is not null && !File.Exists(ProfilePath(ActiveSlug)))
        {
            // BUGDESK_USER for someone who has never run BugDesk here is a
            // legitimate first run FOR THEM: materialise the profile rather than
            // booting nameless.
            if (_envUser is not null) NewProfile(_envUser, _envAgent);
            else ActiveSlug = null;   // stale pointer (profile deleted) — ask again
        }

        // BUGDESK_HUMAN with nothing configured: SEED a profile from it, rather
        // than carrying the name around as a permanent override. This is the
        // whole of what the variable does now — it answers "who is this, the
        // first time", and the file it writes answers every time after that.
        //
        // Deliberately does NOT write active.json, exactly as BUGDESK_USER does
        // not: one `BUGDESK_HUMAN=bob ./run.sh` must not silently repoint the
        // checkout's default for everyone else who runs it. Changing the name in
        // the UI is an explicit act and does persist.
        if (ActiveSlug is null && _envHuman is not null) NewProfile(_envHuman, _envAgent);
    }

    /* ── identity ──────────────────────────────────────────────────── */

    /// <summary>
    /// False only when nothing anywhere says who the user is — the one case that
    /// earns the first-run prompt. A <c>BUGDESK_HUMAN</c> deployment is
    /// configured because the constructor has already written its profile.
    /// </summary>
    public bool Configured => ActiveSlug is not null;

    /// <summary>
    /// The profile first, the environment only as the seed it did not get to
    /// use. See the class remarks: an env var starts a process, a profile is
    /// what the user changed, and the second is the more recent statement.
    /// </summary>
    public string HumanAuthor =>
        Str(Active()?["name"]) ?? _envHuman ?? "reviewer";

    public string AgentAuthor =>
        Str(Active()?["agentName"]) ?? _envAgent ?? "agent";

    /* ── profiles ──────────────────────────────────────────────────── */

    /// <summary>Every profile in the config dir — what the first-run screen offers as "you again?".</summary>
    public List<object> Profiles()
    {
        var list = new List<object>();
        if (!Directory.Exists(ConfigDir)) return list;
        foreach (var path in Directory.EnumerateFiles(ConfigDir, "user-*.json").OrderBy(p => p))
        {
            var doc = ReadJson(path);
            if (doc is null) continue;
            var slug = Str(doc["slug"]) ?? Path.GetFileNameWithoutExtension(path)["user-".Length..];
            list.Add(new
            {
                slug,
                name = Str(doc["name"]) ?? slug,
                agentName = Str(doc["agentName"]) ?? "",
                active = slug == ActiveSlug,
            });
        }
        return list;
    }

    /// <summary>
    /// Adopt a profile: reuse the existing file for that name, or create one.
    /// Also makes it this checkout's active profile — which is what the first-run
    /// screen is for. Returns the resolved slug.
    /// </summary>
    public string SelectOrCreate(string name, string? agentName)
    {
        var slug = SlugOf(name);
        lock (_gate)
        {
            var doc = ReadJson(ProfilePath(slug)) ?? NewProfileDoc(name, slug);
            doc["name"] = name.Trim();
            if (!Blank(agentName)) doc["agentName"] = agentName!.Trim();
            doc["updated"] = Md.Today();
            WriteJson(ProfilePath(slug), doc);

            ActiveSlug = slug;
            // Not written when BUGDESK_USER is in force: that variable is this
            // process's business, and persisting it would leak into every other
            // run from the same checkout.
            if (_envUser is null) WriteJson(ActivePath, new JsonObject { ["user"] = slug });
        }
        return slug;
    }

    /* ── per-user payloads ─────────────────────────────────────────── */

    /// <summary>The user's saved queue/backlog filters (the UI owns their shape).</summary>
    public JsonArray Filters()
    {
        var arr = Active()?["filters"] as JsonArray;
        return arr is null ? new JsonArray() : (JsonArray)arr.DeepClone();
    }

    public void SetFilters(JsonArray filters) => Mutate(doc => doc["filters"] = filters.DeepClone());

    /// <summary>An open bag the UI persists its own preferences into.</summary>
    public JsonObject Settings()
    {
        var obj = Active()?["settings"] as JsonObject;
        return obj is null ? new JsonObject() : (JsonObject)obj.DeepClone();
    }

    /// <summary>Merge (not replace) — the UI saves one key at a time.</summary>
    public void MergeSettings(JsonObject patch) => Mutate(doc =>
    {
        var settings = doc["settings"] as JsonObject ?? new JsonObject();
        foreach (var (k, v) in patch) settings[k] = v?.DeepClone();
        doc["settings"] = settings;
    });

    /* ── workspace state (WM layout) ───────────────────────────────── */

    /// <summary>
    /// Layout persistence for <c>@flexdesk/host</c>'s state capability. The WM
    /// hands us a logical path; only its file name is used, so nothing it sends
    /// can escape the profile's own directory.
    /// </summary>
    public string? ReadState(string path)
    {
        var file = StatePath(path);
        return file is not null && File.Exists(file) ? File.ReadAllText(file) : null;
    }

    public bool WriteState(string path, string data)
    {
        var file = StatePath(path);
        if (file is null) return false;
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, data);
        return true;
    }

    string? StatePath(string path)
    {
        if (ActiveSlug is null) return null;                    // nameless run — nothing to key on
        var name = Path.GetFileName(path.Replace('\\', '/'));
        if (Blank(name) || name is "." or "..") return null;
        return Path.Combine(ConfigDir, $"state-{ActiveSlug}", name);
    }

    /* ── migration ─────────────────────────────────────────────────── */

    /// <summary>
    /// Fold a pre-profile <c>server/state/filters.json</c> into the profile that
    /// is active when the upgrade happens. Filters were server-global before they
    /// were per-user; dropping them on the floor at upgrade would look exactly
    /// like the UI losing the user's work.
    /// <para>
    /// It runs EXACTLY ONCE: on success the legacy file is renamed aside. Without
    /// that, the "global" filters would be handed to every person who ever
    /// creates a profile in this repo — so the second colleague to run BugDesk
    /// would open it to a stranger's saved filters, which is the opposite of what
    /// per-user config is for. The file is renamed rather than deleted; it is
    /// someone's work, and it stays readable on disk.
    /// </para>
    /// </summary>
    public void MigrateLegacyFilters(string legacyPath)
    {
        lock (_gate)
        {
            if (ActiveSlug is null || !File.Exists(legacyPath)) return;
            var doc = Active();
            if (doc is null || doc["filters"] is JsonArray existing && existing.Count > 0) return;
            try
            {
                if (JsonNode.Parse(File.ReadAllText(legacyPath)) is not JsonArray legacy || legacy.Count == 0) return;
                doc["filters"] = legacy.DeepClone();
                WriteJson(ProfilePath(ActiveSlug), doc);
                File.Move(legacyPath, legacyPath + ".migrated", overwrite: true);
            }
            catch (JsonException)
            {
                // A corrupt legacy file is not worth failing a boot over, and it
                // is still sitting on disk for anyone who wants to look at it.
            }
            catch (IOException)
            {
                // The filters ARE in the profile by now; a failed rename only
                // risks a second migration, which the `existing.Count > 0` guard
                // above already makes a no-op for this user.
            }
        }
    }

    /* ── plumbing ──────────────────────────────────────────────────── */

    string ActivePath => Path.Combine(ConfigDir, "active.json");
    string ProfilePath(string slug) => Path.Combine(ConfigDir, $"user-{slug}.json");

    JsonObject? Active() => ActiveSlug is null ? null : ReadJson(ProfilePath(ActiveSlug));

    void Mutate(Action<JsonObject> edit)
    {
        lock (_gate)
        {
            if (ActiveSlug is null) return;
            var doc = Active() ?? NewProfileDoc(HumanAuthor, ActiveSlug);
            edit(doc);
            doc["updated"] = Md.Today();
            WriteJson(ProfilePath(ActiveSlug), doc);
        }
    }

    /// <summary>
    /// Materialise a profile and make it this process's active one.
    /// <para>
    /// The agent name is DERIVED when none is given, by the same rule
    /// <see cref="ProjectConfig.AgentNameFor"/> applies everywhere else — a
    /// profile written with a blank one would fall through to the generic
    /// "agent", and two people's assistants signing identically is the thing
    /// that rule exists to prevent.
    /// </para>
    /// </summary>
    JsonObject NewProfile(string name, string? agentName)
    {
        var slug = SlugOf(name);
        var doc = NewProfileDoc(name, slug);
        doc["agentName"] = Blank(agentName) ? ProjectConfig.AgentNameFor(name) : agentName!.Trim();
        ActiveSlug = slug;
        WriteJson(ProfilePath(slug), doc);
        return doc;
    }

    static JsonObject NewProfileDoc(string name, string slug) => new()
    {
        ["slug"] = slug,
        ["name"] = name.Trim(),
        ["agentName"] = "",
        ["created"] = Md.Today(),
        ["updated"] = Md.Today(),
        ["filters"] = new JsonArray(),
        ["settings"] = new JsonObject(),
    };

    /// <summary>The one file in here that IS committed. Everything else is yours alone.</summary>
    public const string SharedFileName = "project.json";

    static readonly string[] GitIgnoreLines =
    {
        "# BugDesk keeps two different things in this directory, and this file is",
        "# what tells them apart.",
        "#",
        "# IGNORED — everything else here is YOURS: your name, your saved filters,",
        "# your window layout. Committing it would have two people on this repo",
        "# overwrite each other's identity on every pull.",
        "#",
        "# TRACKED — project.json is the SHARED roster: who can be assigned work",
        "# here. Everybody has to agree on that one, so it is committed, and the",
        "# negation below is what lets it be.",
        "#",
        "# The bug and backlog stores themselves are of course meant to be",
        "# committed; they live outside this directory.",
        "*",
        "!.gitignore",
        "!" + SharedFileName,
        "",
    };

    /// <summary>
    /// Ignore this directory's private half and re-include the shared file.
    /// Self-contained, so BugDesk never has to edit — or even find — the
    /// surrounding project's own .gitignore.
    ///
    /// <para>
    /// An EXISTING file is upgraded rather than left alone. Before the roster
    /// moved in here this said a plain <c>*</c>, and leaving that in place on an
    /// upgrade would ignore <c>project.json</c> — the roster would be written,
    /// look fine locally, and silently never reach anybody else's checkout,
    /// which is the exact failure a shared file has no way to report. The
    /// negations are APPENDED, so a line anyone added by hand survives.
    /// </para>
    /// </summary>
    void EnsureGitIgnore()
    {
        var path = Path.Combine(ConfigDir, ".gitignore");
        if (!File.Exists(path))
        {
            File.WriteAllText(path, string.Join('\n', GitIgnoreLines));
            return;
        }
        try
        {
            var text = File.ReadAllText(path);
            if (text.Contains("!" + SharedFileName, StringComparison.Ordinal)) return;
            var suffix = text.EndsWith('\n') ? "" : "\n";
            File.AppendAllText(path, suffix + string.Join('\n', new[]
            {
                "",
                "# project.json is the SHARED collaborator roster and belongs in git;",
                "# everything else in here is per-user and does not.",
                "!.gitignore",
                "!" + SharedFileName,
                "",
            }));
        }
        catch (IOException)
        {
            // A .gitignore we cannot rewrite is not worth failing a boot over.
            // The consequence is a roster that stays local, which the README's
            // "Where config lives" section tells the user how to check.
        }
    }

    static JsonObject? ReadJson(string path)
    {
        if (!File.Exists(path)) return null;
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
        catch (JsonException) { return null; }
    }

    static void WriteJson(string path, JsonObject doc)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    static string? Str(JsonNode? n)
    {
        var s = n?.GetValue<string>();
        return Blank(s) ? null : s;
    }

    static bool Blank(string? s) => string.IsNullOrWhiteSpace(s);

    /// <summary>
    /// A file-name-safe key for a display name. Two names that differ only in
    /// case or punctuation collapse onto one profile on purpose — "Alice" and
    /// "alice" are the same person, and a second file for them would silently
    /// split their filters in half.
    /// </summary>
    public static string SlugOf(string name)
    {
        var sb = new StringBuilder();
        foreach (var ch in name.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch)) sb.Append(ch);
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
        }
        var slug = sb.ToString().Trim('-');
        return slug.Length == 0 ? "user" : slug;
    }
}
