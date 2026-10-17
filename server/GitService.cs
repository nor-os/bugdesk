using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

/// <summary>
/// Git for a store's RECORD files, and nothing else — what the Changes pane and
/// "commit after save" need (Settings › Git).
///
/// <para>
/// BugDesk only ever stages and commits files that are records in this store's
/// folders, by path: <c>git commit -- &lt;file&gt;</c> commits that file and
/// nothing somebody else happened to stage, and a path outside the stores is
/// refused before git is asked. The repo around the stores holds other people's
/// code and their work in progress; a tool that writes records has no business
/// with either.
/// </para>
///
/// <para>
/// A push runs in the background and can fail for reasons outside BugDesk (no
/// remote, rejected, no credentials). Its last result is kept and shown in the
/// pane with git's own message; the commit stays local and nothing is lost.
/// </para>
/// </summary>
sealed class GitService
{
    static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);
    static readonly TimeSpan PushTimeout = TimeSpan.FromSeconds(90);
    static readonly Regex RecordName = new(@"^[A-Za-z]+-\d+\.md$");

    readonly string[] _dirs;
    readonly object _gate = new();

    public string? Root { get; }

    /// <summary>The store's settings folder (<c>.bugdesk/</c>). Its changed files
    /// are NAMED in the Changes pane — project.json is shared settings, and a
    /// pane that hid it would leave somebody wondering why git is dirty — but
    /// never committed from there.</summary>
    public string? ConfigDir { get; init; }

    /// <summary>The last push: when, whether it worked, and what git said.</summary>
    public (DateTime At, bool Ok, string Message)? LastPush { get; private set; }
    public bool Pushing { get; private set; }

    public GitService(params string[] dirs)
    {
        _dirs = dirs.Where(d => !string.IsNullOrEmpty(d)).Select(Path.GetFullPath).ToArray();
        var probe = _dirs.FirstOrDefault(Directory.Exists);
        if (probe is not null)
        {
            var (ok, output, _) = Run(probe, Timeout, "rev-parse", "--show-toplevel");
            if (ok && output.Trim().Length > 0) Root = Path.GetFullPath(output.Trim());
        }
    }

    public bool Enabled => Root is not null;

    /// <summary>Is this a record file in one of the store's folders?</summary>
    public bool IsRecord(string path)
    {
        var full = Path.GetFullPath(path);
        return RecordName.IsMatch(Path.GetFileName(full))
            && _dirs.Any(d => string.Equals(Path.GetDirectoryName(full), d, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The store's uncommitted record files: `{path (repo-relative), status}`.</summary>
    public List<(string Path, string Status)> Changes()
    {
        var list = new List<(string, string)>();
        if (Root is null) return list;
        var args = new List<string> { "status", "--porcelain=v1", "-uall", "--" };
        args.AddRange(_dirs.Select(d => Path.GetRelativePath(Root, d)));
        var (ok, output, _) = Run(Root, Timeout, args.ToArray());
        if (!ok) return list;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.Length < 4) continue;
            var code = line[..2];
            var rel = line[3..].Trim().Trim('"');
            if (rel.Contains(" -> ")) rel = rel[(rel.IndexOf(" -> ", StringComparison.Ordinal) + 4)..];
            if (!IsRecord(System.IO.Path.Combine(Root, rel))) continue;
            var status = code.Contains('?') ? "new" : code.Contains('D') ? "deleted" : code.Contains('A') ? "new" : "modified";
            list.Add((rel.Replace('\\', '/'), status));
        }
        return list;
    }

    /// <summary>
    /// Changed files in the store's folders and its settings folder that are NOT
    /// records — repo-relative. The pane names them; BugDesk does not commit them.
    /// </summary>
    public List<string> Others()
    {
        var list = new List<string>();
        if (Root is null) return list;
        var args = new List<string> { "status", "--porcelain=v1", "-uall", "--" };
        args.AddRange(_dirs.Select(d => Path.GetRelativePath(Root, d)));
        if (ConfigDir is { Length: > 0 } cfg && Directory.Exists(cfg)) args.Add(Path.GetRelativePath(Root, Path.GetFullPath(cfg)));
        var (ok, output, _) = Run(Root, Timeout, args.ToArray());
        if (!ok) return list;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.Length < 4) continue;
            var rel = line[3..].Trim().Trim('"');
            if (rel.Contains(" -> ")) rel = rel[(rel.IndexOf(" -> ", StringComparison.Ordinal) + 4)..];
            if (IsRecord(System.IO.Path.Combine(Root, rel))) continue;
            list.Add(rel.Replace('\\', '/'));
        }
        return list.Distinct().ToList();
    }

    /// <summary>A record file's text as last committed; "" when HEAD does not have it.</summary>
    public string Committed(string rel)
    {
        if (Root is null || !IsRecord(System.IO.Path.Combine(Root, rel))) return "";
        var (ok, output, _) = Run(Root, Timeout, "show", $"HEAD:{rel.Replace('\\', '/')}");
        return ok ? output : "";
    }

    /// <summary>
    /// Throw away the uncommitted changes to one record file. A file HEAD has is
    /// put back as committed (an edit undone, a deletion restored); a file HEAD
    /// never had is moved to <paramref name="trashDir"/> rather than unlinked, as
    /// every other removal in BugDesk is. Returns null on success, else why not.
    /// </summary>
    public string? Discard(string rel, string trashDir)
    {
        if (Root is null) return "the store is not in a git repository";
        var full = System.IO.Path.Combine(Root, rel);
        if (!IsRecord(full)) return $"'{rel}' is not a record file of this store; BugDesk only discards records.";
        rel = System.IO.Path.GetRelativePath(Root, Path.GetFullPath(full)).Replace('\\', '/');
        lock (_gate)
        {
            var (inHead, _, _) = Run(Root, Timeout, "cat-file", "-e", $"HEAD:{rel}");
            if (inHead)
            {
                var (ok, _, err) = Run(Root, Timeout, "checkout", "HEAD", "--", rel);
                return ok ? null : err.Trim();
            }
            Run(Root, Timeout, "rm", "--cached", "-q", "--ignore-unmatch", "--", rel);
            if (!File.Exists(full)) return null;
            Directory.CreateDirectory(trashDir);
            File.Move(full, System.IO.Path.Combine(trashDir, $"{DateTime.Now:yyyyMMdd-HHmmss}-{System.IO.Path.GetFileName(full)}"));
            return null;
        }
    }

    /// <summary>The diff of one record file against HEAD (a new file: all of it).</summary>
    public string Diff(string rel)
    {
        if (Root is null) return "";
        var full = System.IO.Path.Combine(Root, rel);
        if (!IsRecord(full)) return "";
        var (_, tracked, _) = Run(Root, Timeout, "ls-files", "--", rel);
        if (tracked.Trim().Length == 0)
            return File.Exists(full) ? string.Join("\n", File.ReadAllLines(full).Select(l => "+" + l)) : "";
        var (_, diff, _) = Run(Root, Timeout, "diff", "HEAD", "--", rel);
        return diff;
    }

    /// <summary>
    /// Commit these record files, and only these. Returns null on success, else
    /// git's message. Nothing to commit (the file is unchanged) is not an error.
    /// </summary>
    public string? Commit(IEnumerable<string> paths, string message)
    {
        if (Root is null) return "the store is not in a git repository";
        var rels = new List<string>();
        foreach (var p in paths)
        {
            var full = System.IO.Path.IsPathRooted(p) ? p : System.IO.Path.Combine(Root, p);
            if (!IsRecord(full)) return $"'{p}' is not a record file of this store; BugDesk only commits records.";
            rels.Add(System.IO.Path.GetRelativePath(Root, full).Replace('\\', '/'));
        }
        if (rels.Count == 0) return "nothing to commit";
        lock (_gate)
        {
            var add = new List<string> { "add", "-A", "--" }; add.AddRange(rels);
            var (aok, _, aerr) = Run(Root, Timeout, add.ToArray());
            if (!aok) return aerr.Trim();
            // Unchanged files: nothing to do, and git would say "no changes".
            var (_, staged, _) = Run(Root, Timeout, new[] { "diff", "--cached", "--name-only", "--" }.Concat(rels).ToArray());
            if (staged.Trim().Length == 0) return null;
            var commit = new List<string> { "commit", "-q", "-m", message, "--" }; commit.AddRange(rels);
            var (cok, cout, cerr) = Run(Root, Timeout, commit.ToArray());
            return cok ? null : (cerr.Trim().Length > 0 ? cerr.Trim() : cout.Trim());
        }
    }

    /// <summary>How many local commits the branch's upstream does not have yet;
    /// -1 when there is no upstream.</summary>
    public int Ahead()
    {
        if (Root is null) return -1;
        var (ok, output, _) = Run(Root, Timeout, "rev-list", "--count", "@{u}..HEAD");
        return ok && int.TryParse(output.Trim(), out var n) ? n : -1;
    }

    /// <summary>The repository's remotes, by name; empty when it has none at all
    /// — which is not the same as the branch having no upstream (<see cref="Ahead"/>
    /// is -1 for both). Settings › Git and the warnings tell the two apart (STORY-0049).</summary>
    public List<string> Remotes()
    {
        if (Root is null) return new();
        var (ok, output, _) = Run(Root, Timeout, "remote");
        return ok ? output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList() : new();
    }

    /// <summary>
    /// Add <paramref name="url"/> as the repository's <c>origin</c>. Offered only
    /// to a repository with no remote at all, so it never replaces one. Returns
    /// null on success, else why not. A URL with spaces or one that git would
    /// read as an option is refused before git is asked.
    /// </summary>
    public string? AddRemote(string url)
    {
        if (Root is null) return "the store is not in a git repository";
        url = url.Trim();
        if (url.Length == 0) return "A remote needs a URL.";
        if (url.StartsWith('-') || url.Any(c => char.IsWhiteSpace(c) || char.IsControl(c)))
            return $"'{url}' is not a remote URL: it may not contain spaces or start with '-'.";
        lock (_gate)
        {
            if (Remotes().Count > 0) return "This repository already has a remote.";
            var (ok, _, err) = Run(Root, Timeout, "remote", "add", "origin", url);
            return ok ? null : err.Trim();
        }
    }

    /// <summary>
    /// <c>git init</c> in <paramref name="dir"/> — only ever because somebody
    /// asked (STORY-0049): BugDesk does not put a store under git by itself.
    /// Returns null on success, else git's message. The caller builds a new
    /// <see cref="GitService"/> afterwards, since <see cref="Root"/> is found once.
    /// </summary>
    public static string? Init(string dir)
    {
        if (!Directory.Exists(dir)) return $"'{dir}' does not exist.";
        var (ok, output, err) = Run(dir, Timeout, "init", "-q");
        return ok ? null : (err.Trim().Length > 0 ? err.Trim() : output.Trim());
    }

    public string Branch()
    {
        if (Root is null) return "";
        var (ok, output, _) = Run(Root, Timeout, "rev-parse", "--abbrev-ref", "HEAD");
        if (ok && output.Trim() != "HEAD") return output.Trim();
        // A repository with no commits yet (just initialized) has no HEAD to
        // parse, but its branch still has a name; a detached HEAD has none.
        var (sok, sym, _) = Run(Root, Timeout, "symbolic-ref", "--short", "-q", "HEAD");
        return sok ? sym.Trim() : output.Trim();
    }

    /// <summary>Push the current branch, in the background. <paramref name="done"/>
    /// is told when it has finished either way.</summary>
    public void PushInBackground(Action? done = null)
    {
        if (Root is null) return;
        lock (_gate)
        {
            if (Pushing) return;
            Pushing = true;
        }
        _ = Task.Run(() =>
        {
            var (ok, output, err) = Run(Root, PushTimeout, "push");
            var said = (err + "\n" + output).Trim();
            LastPush = (DateTime.UtcNow, ok, ok ? (said.Length > 0 ? said : "Pushed.") : (said.Length > 0 ? said : "git push failed."));
            Pushing = false;
            try { done?.Invoke(); } catch { /* a listener's problem, not the push's */ }
        });
    }

    static (bool Ok, string Out, string Err) Run(string cwd, TimeSpan timeout, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo("git")
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            // Never stop and ask: a credential prompt nobody can see would hang the push.
            psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var git = Process.Start(psi);
            if (git is null) return (false, "", "git could not be started");
            var output = git.StandardOutput.ReadToEndAsync();
            var error = git.StandardError.ReadToEndAsync();
            if (!git.WaitForExit(timeout))
            {
                try { git.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return (false, "", $"git {args[0]} did not finish within {timeout.TotalSeconds:0} seconds");
            }
            return (git.ExitCode == 0, output.Result, error.Result);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return (false, "", "git is not installed or not on PATH");
        }
    }
}

/// <summary>
/// The project's saving and git settings — <c>git</c> in project.json: whether a
/// save commits and a commit pushes (STORY-0006), and whether the record pages
/// save by themselves (STORY-0020): <c>off</c>, every <c>interval</c> seconds, or
/// <c>debounce</c> — that many seconds after the last keystroke.
/// </summary>
record GitSettings(bool CommitAfterSave, bool PushAfterCommit, string Autosave = "off", int AutosaveSeconds = 0)
{
    public static GitSettings Parse(JsonNode? n) => new GitSettings(
        n?["commitAfterSave"] is JsonValue c && c.TryGetValue<bool>(out var cv) && cv,
        n?["pushAfterCommit"] is JsonValue p && p.TryGetValue<bool>(out var pv) && pv,
        n?["autosave"] is JsonValue a && a.TryGetValue<string>(out var av) ? av : "off",
        n?["autosaveSeconds"] is JsonValue s && s.TryGetValue<int>(out var sv) ? sv : 0).Normalised();

    /// <summary>Unknown modes are off; `interval`, a mode no longer offered, is read as
    /// debounced. Seconds default to 2.</summary>
    public GitSettings Normalised()
    {
        var mode = Autosave is "interval" or "debounce" ? "debounce" : "off";
        var secs = mode == "off" ? 0 : Math.Clamp(AutosaveSeconds > 0 ? AutosaveSeconds : 2, 1, 3600);
        return this with { Autosave = mode, AutosaveSeconds = secs };
    }

    public JsonObject ToJson() => new()
    {
        ["commitAfterSave"] = CommitAfterSave, ["pushAfterCommit"] = PushAfterCommit,
        ["autosave"] = Autosave, ["autosaveSeconds"] = AutosaveSeconds,
    };

    /// <summary>
    /// What one person's pages do. Auto-save is a habit, not a team policy, so it
    /// is theirs to choose (STORY-0032): <c>autosave</c>/<c>autosaveSeconds</c> in
    /// their profile's settings, set in Settings › Behaviour. Until they choose,
    /// the project's value applies. Commit and push stay the project's. The
    /// project's own auto-save is reported beside it, for the page to say what
    /// "the project's default" is.
    /// </summary>
    public JsonObject ForUser(JsonObject user)
    {
        var own = user["autosave"] is JsonValue a && a.TryGetValue<string>(out var av) ? av : null;
        var mine = own is null ? this : (this with
        {
            Autosave = own,
            AutosaveSeconds = user["autosaveSeconds"] is JsonValue s && s.TryGetValue<int>(out var sv) ? sv : 0,
        }).Normalised();
        var j = mine.ToJson();
        j["ownAutosave"] = own is not null;
        j["projectAutosave"] = Autosave;
        j["projectAutosaveSeconds"] = AutosaveSeconds;
        return j;
    }
}
