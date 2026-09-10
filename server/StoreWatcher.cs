using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

/// <summary>One file the watcher saw change, as reported to the browser.</summary>
record ChangedFile(string File, string Store, int Id, bool Deleted);

/// <summary>
/// Watches the stores for changes BugDesk did not make, and pushes them to every
/// open browser over Server-Sent Events.
///
/// <para>
/// The markdown files are the source of truth, and the whole point of that is
/// that other things write them: a <c>git pull</c>, an agent working through the
/// <c>/bugs</c> skill, somebody's editor. Before this, the UI only ever saw the
/// store as it was at page load, so an agent could move a bug to `testing` and
/// the human would sit looking at `investigation` until they happened to
/// reload — and if they then saved, they would silently overwrite the agent.
/// </para>
///
/// <para>
/// ECHO SUPPRESSION is the part that has to be right. Every write BugDesk makes
/// also trips the watcher, and reporting those back would mean every save
/// announced itself as "changed in the background". Timing windows are the
/// obvious fix and the wrong one — a slow disk or a debounce boundary turns them
/// into a race. Instead the bridge records the SHA-256 of what it wrote, and an
/// event whose file still hashes to that value is its own echo. It cannot
/// misfire: if the content on disk is byte-for-byte what we last wrote, there is
/// by definition nothing new to tell anyone.
/// </para>
///
/// <para>
/// Events are COALESCED over a short quiet period. A `git pull` rewrites twenty
/// files and FileSystemWatcher reports each of them two or three times; twenty
/// separate reloads of the same list would be pointless work and a visibly
/// flickering table.
/// </para>
/// </summary>
sealed class StoreWatcher : IDisposable
{
    /// <summary>How long to wait for the dust to settle before broadcasting.</summary>
    static readonly TimeSpan Quiet = TimeSpan.FromMilliseconds(250);

    /// <summary>Idle keep-alive. Proxies and browsers drop a silent stream.</summary>
    public static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(25);

    readonly object _gate = new();
    readonly List<FileSystemWatcher> _watchers = new();
    readonly Dictionary<string, string> _ourWrites = new(StringComparer.OrdinalIgnoreCase);
    readonly HashSet<Channel<string>> _subscribers = new();
    readonly HashSet<string> _pending = new(StringComparer.OrdinalIgnoreCase);
    readonly ILogger _log;
    Timer? _debounce;

    public StoreWatcher(string bugsDir, string backlogDir, string projectFile, ILogger log)
    {
        _log = log;
        Watch(bugsDir, "BUG-*.md");
        // One watcher per prefix, and the list has to be the SAME one the store
        // knows about — PROJ-*.md was missing, so a project record created or
        // changed outside BugDesk never reached an open browser at all, while
        // every other type did. Driven off BacklogItem.Prefixes now, so a fifth
        // type cannot be half-added.
        foreach (var prefix in BacklogItem.Prefixes.Values) Watch(backlogDir, $"{prefix}-*.md");
        // The collaborator roster is committed too, so it arrives on a pull like
        // any record does.
        var projectDir = Path.GetDirectoryName(projectFile);
        if (!string.IsNullOrEmpty(projectDir)) Watch(projectDir, Path.GetFileName(projectFile));
    }

    void Watch(string dir, string filter)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            var w = new FileSystemWatcher(dir, filter)
            {
                // Size alone misses an edit that keeps the length; LastWrite
                // alone misses a git checkout that restores the timestamp.
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                IncludeSubdirectories = false,
                EnableRaisingEvents = true,
            };
            w.Changed += (_, e) => Touch(e.FullPath);
            w.Created += (_, e) => Touch(e.FullPath);
            w.Deleted += (_, e) => Touch(e.FullPath);
            w.Renamed += (_, e) => { Touch(e.OldFullPath); Touch(e.FullPath); };
            // A watcher that has died is worse than none: it looks like "nothing
            // has changed" forever. Say so.
            w.Error += (_, e) => _log.LogWarning(e.GetException(), "BugDesk: file watcher on {dir} failed", dir);
            _watchers.Add(w);
        }
        catch (Exception ex)
        {
            // Watching is a convenience, not a dependency — a platform that
            // cannot (an exotic filesystem, an inotify limit) still serves.
            _log.LogWarning(ex, "BugDesk: cannot watch {dir}, live updates are off for it", dir);
        }
    }

    /// <summary>
    /// Record what WE just wrote, so the resulting watcher event is recognised
    /// as our own echo. Call after every write to a watched file.
    /// </summary>
    public void Note(string path, string content)
    {
        lock (_gate) _ourWrites[Path.GetFullPath(path)] = Hash(content);
    }

    /// <summary>
    /// Remember that WE removed this file, so its disappearance is not reported
    /// back to us as somebody else's edit.
    /// <para>
    /// A deletion carries no content, so the SHA-256 trick <see cref="Note"/>
    /// uses has nothing to compare — this records a sentinel the flush treats as
    /// "ours" when the file turns out to be gone. Other browsers still get the
    /// event: it is only the process that did the deleting that already knows.
    /// </para>
    /// </summary>
    public void NoteDeletion(string path)
    {
        lock (_gate) _ourWrites[Path.GetFullPath(path)] = DeletedSentinel;
    }

    const string DeletedSentinel = "\u0000deleted";

    static string Hash(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content)));

    void Touch(string path)
    {
        lock (_gate)
        {
            _pending.Add(Path.GetFullPath(path));
            _debounce?.Dispose();
            _debounce = new Timer(_ => Flush(), null, Quiet, Timeout.InfiniteTimeSpan);
        }
    }

    void Flush()
    {
        string[] paths;
        lock (_gate)
        {
            _debounce?.Dispose();
            _debounce = null;
            if (_pending.Count == 0) return;
            paths = _pending.ToArray();
            _pending.Clear();
        }

        var changed = new List<ChangedFile>();
        foreach (var path in paths)
        {
            var name = Path.GetFileName(path);
            var exists = File.Exists(path);

            if (exists)
            {
                string content;
                try { content = File.ReadAllText(path); }
                catch (IOException) { continue; }   // still being written; the next event will carry it

                lock (_gate)
                {
                    if (_ourWrites.TryGetValue(path, out var mine) && mine == Hash(content)) continue;
                    // Somebody else's content is now on disk — forget ours, so
                    // a later revert BACK to our version is still reported.
                    _ourWrites.Remove(path);
                }
            }
            else
            {
                lock (_gate)
                {
                    // Our own delete (see NoteDeletion) — the file is gone
                    // because we removed it, and this process already knows.
                    var mine = _ourWrites.TryGetValue(path, out var m) && m == DeletedSentinel;
                    _ourWrites.Remove(path);
                    if (mine) continue;
                }
            }

            changed.Add(new ChangedFile(name, StoreOf(name), IdOf(name), !exists));
        }

        if (changed.Count == 0) return;
        _log.LogInformation("BugDesk: {n} external change(s) in the store", changed.Count);
        Broadcast("store", JsonSerializer.Serialize(new
        {
            changed = changed.Select(c => new { file = c.File, store = c.Store, id = c.Id, deleted = c.Deleted }),
            stores = changed.Select(c => c.Store).Distinct().ToArray(),
            at = DateTime.UtcNow.ToString("O"),
        }));
    }

    static string StoreOf(string fileName) =>
        fileName.StartsWith("BUG-", StringComparison.OrdinalIgnoreCase) ? "bugs"
        : fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? "project"
        : "backlog";

    /// <summary>The record id in a file name, or 0 for anything that is not a record.</summary>
    static int IdOf(string fileName)
    {
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var dash = stem.LastIndexOf('-');
        return dash >= 0 && int.TryParse(stem[(dash + 1)..], out var n) ? n : 0;
    }

    /* ── SSE plumbing ────────────────────────────────────────────── */

    /// <summary>
    /// Subscribe one browser. The channel DROPS THE OLDEST message when full
    /// rather than blocking: a stalled reader must not be able to hold up the
    /// watcher for everybody else, and the client resyncs from the API anyway.
    /// </summary>
    public Channel<string> Subscribe()
    {
        var ch = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });
        lock (_gate) _subscribers.Add(ch);
        return ch;
    }

    public void Unsubscribe(Channel<string> ch)
    {
        lock (_gate) _subscribers.Remove(ch);
        ch.Writer.TryComplete();
    }

    public int SubscriberCount { get { lock (_gate) return _subscribers.Count; } }

    void Broadcast(string eventName, string json)
    {
        var frame = $"event: {eventName}\ndata: {json}\n\n";
        Channel<string>[] subs;
        lock (_gate) subs = _subscribers.ToArray();
        foreach (var ch in subs) ch.Writer.TryWrite(frame);
    }

    /// <summary>Tell every open browser something, unprompted. Used by tests and
    /// by anything that changes the stores without going through a file.</summary>
    public void Announce(string eventName, object payload) =>
        Broadcast(eventName, JsonSerializer.Serialize(payload));

    public void Dispose()
    {
        lock (_gate)
        {
            _debounce?.Dispose();
            foreach (var w in _watchers) { try { w.Dispose(); } catch { /* shutting down */ } }
            _watchers.Clear();
            foreach (var ch in _subscribers) ch.Writer.TryComplete();
            _subscribers.Clear();
        }
    }
}
