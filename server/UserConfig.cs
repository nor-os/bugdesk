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
///     .gitignore              "*" — the directory ignores itself, so nothing
///                             here can be committed by accident, and no edit
///                             to the project's own .gitignore is needed
///     active.json             which profile THIS checkout is using
///     user-alice.json         alice's name, filters and settings
///     user-bob.json           bob's
///     state-alice/            alice's workspace layout (desktops, tiles)
/// </code>
///
/// <para>
/// The first run has no profile, so <see cref="Configured"/> is false and the UI
/// asks for a name before it renders anything else (see
/// <c>ui/js/ticketdesk/first_run.js</c>). Everything after that is a reload of
/// the same file.
/// </para>
///
/// <para>
/// Environment variables still win, for CI and for two people sharing one
/// checkout: <c>BUGDESK_USER</c> picks a profile without rewriting
/// <c>active.json</c>, and <c>BUGDESK_HUMAN</c>/<c>BUGDESK_AGENT</c> override the
/// names outright (which also suppresses the first-run prompt — an explicitly
/// configured deployment is not "unconfigured").
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
            if (_envUser is not null) Write(NewProfile(_envUser, null));
            else ActiveSlug = null;   // stale pointer (profile deleted) — ask again
        }
    }

    /* ── identity ──────────────────────────────────────────────────── */

    /// <summary>
    /// False only when nothing anywhere says who the user is — the one case that
    /// earns the first-run prompt.
    /// </summary>
    public bool Configured => _envHuman is not null || ActiveSlug is not null;

    /// <summary>True when the name comes from the environment and the UI must not offer to change it.</summary>
    public bool EnvLocked => _envHuman is not null;

    public string HumanAuthor =>
        _envHuman ?? Active()?["name"]?.GetValue<string>() ?? "reviewer";

    public string AgentAuthor =>
        _envAgent ?? Str(Active()?["agentName"]) ?? "agent";

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

    JsonObject NewProfile(string name, string? agentName)
    {
        var slug = SlugOf(name);
        var doc = NewProfileDoc(name, slug);
        if (!Blank(agentName)) doc["agentName"] = agentName!.Trim();
        ActiveSlug = slug;
        WriteJson(ProfilePath(slug), doc);
        return doc;
    }

    void Write(JsonObject doc) => WriteJson(ProfilePath(Str(doc["slug"])!), doc);

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

    /// <summary>
    /// "*" plus a note. Self-ignoring, so BugDesk never has to edit — or even
    /// find — the surrounding project's own .gitignore.
    /// </summary>
    void EnsureGitIgnore()
    {
        var path = Path.Combine(ConfigDir, ".gitignore");
        if (File.Exists(path)) return;
        File.WriteAllText(path, string.Join('\n', new[]
        {
            "# Per-user BugDesk configuration — names, filters, workspace layout.",
            "# Deliberately not committed: two people on this repo would otherwise",
            "# overwrite each other's identity on every pull. The bug and backlog",
            "# stores themselves ARE meant to be committed.",
            "*",
            "",
        }));
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
