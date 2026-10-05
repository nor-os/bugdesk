using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;

/// <summary>
/// The parsed form of one store's markdown files, kept in memory and mirrored to
/// disk — so a request does not re-read and re-parse every record, and a restart
/// does not either.
///
/// <para>
/// THE FILES STAY THE ONLY SOURCE OF TRUTH. This is a derived cache and nothing
/// in it can be authoritative: vim, <c>git pull</c> and an agent all write the
/// markdown behind our back, and the cache has to be right about that without
/// being told. So it does not trust events. Every lookup lists the folder and
/// compares each file's (mtime, size) against what it parsed; only a file that
/// differs is read again. A listing is a stat per file — no reads, no parsing —
/// and it also notices what a watcher can miss (an event dropped under load, a
/// <c>git checkout</c> that restores old timestamps still changes the size or
/// the mtime it is compared with, a file deleted while we were not running).
/// </para>
///
/// <para>
/// RACY ENTRIES. An mtime only says "not modified since" when the clock moved
/// on after it. A file parsed within <see cref="Racy"/> of its own mtime could be
/// edited again inside the same timestamp tick (coarse on 9p and FAT) and still
/// look unchanged, so such an entry is simply not trusted: it is re-read on the
/// next lookup, by which time the window has closed. Git's index has the same
/// rule for the same reason.
/// </para>
///
/// <para>
/// ON DISK it is one JSON file per store under the config directory, written
/// beside a <c>.gitignore</c> that ignores it. JSON because it is what the rest
/// of BugDesk already reads and writes, it round-trips the record classes
/// unchanged, and a person can open it and see why a record looks the way it
/// does. A binary or SQLite file would buy speed that nothing here needs, and
/// would be one more thing that cannot be diffed or repaired by hand. Because it
/// is derived, every way it can be wrong has the same remedy — throw it away:
/// an unreadable file, a different <c>format</c>, a different <c>build</c> (the
/// parser may have changed, so a rebuilt server never trusts an older parse) all
/// just mean "start empty and parse once". Deleting the file is always safe.
/// </para>
///
/// <para>
/// Records handed out are shared between requests and MUST be treated as
/// read-only; an edit goes to the file, and the next lookup sees it there.
/// </para>
/// </summary>
sealed class RecordCache<T> : IDisposable where T : class
{
    /// <summary>Bumped when the shape of the file changes.</summary>
    const int Format = 1;

    static readonly TimeSpan Racy = TimeSpan.FromSeconds(2);
    static readonly TimeSpan SaveDelay = TimeSpan.FromSeconds(2);

    /// <summary>Identifies THIS build of the parser: any rebuild invalidates a
    /// persisted cache, because the record classes may now be parsed differently.</summary>
    static readonly string Build = typeof(RecordCache<>).Module.ModuleVersionId.ToString("N");

    static readonly JsonSerializerOptions Json = new() { IgnoreReadOnlyProperties = true };

    /// <summary>One file as last seen. <c>Rec</c> is null for a file that does not
    /// parse as a record — remembered so it is not retried on every request.</summary>
    sealed record Entry(long Mtime, long Size, long Seen, T? Rec);

    sealed class Row
    {
        public string File { get; set; } = "";
        public long Mtime { get; set; }
        public long Size { get; set; }
        public long Seen { get; set; }
        public T? Rec { get; set; }
    }

    sealed class Disk
    {
        public int Format { get; set; }
        public string Build { get; set; } = "";
        public List<Row> Rows { get; set; } = new();
    }

    readonly string _dir;
    readonly string[] _patterns;
    readonly Func<string, T?> _parse;
    readonly string? _file;
    readonly object _gate = new();
    readonly object _saveGate = new();
    readonly Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);
    IReadOnlyList<T>? _snapshot;
    bool _loaded, _dirty;
    Timer? _saveTimer;

    /// <param name="persistTo">Where to mirror the cache, or null to keep it in memory only.</param>
    public RecordCache(string dir, string[] patterns, Func<string, T?> parse, string? persistTo)
    {
        _dir = dir;
        _patterns = patterns;
        _parse = parse;
        _file = persistTo;
    }

    /// <summary>
    /// Every record in the folder, sorted by file name. The SAME list instance is
    /// returned for as long as nothing has changed, so anything derived from it
    /// (see <see cref="BacklogIndex"/>) can be cached against it.
    /// </summary>
    public IReadOnlyList<T> All()
    {
        lock (_gate)
        {
            EnsureLoaded();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var changed = false;
            if (Directory.Exists(_dir))
            {
                var info = new DirectoryInfo(_dir);
                foreach (var pattern in _patterns)
                    foreach (var fi in info.EnumerateFiles(pattern))
                        if (seen.Add(fi.Name)) changed |= Refresh(fi);
            }
            foreach (var gone in _entries.Keys.Where(k => !seen.Contains(k)).ToList())
            {
                _entries.Remove(gone);
                changed = true;
            }
            if (changed) _dirty = true;
            if (changed || _snapshot is null)
                _snapshot = _entries.OrderBy(e => e.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(e => e.Value.Rec).OfType<T>().ToList();
            if (_dirty) ScheduleSave();
            return _snapshot;
        }
    }

    /// <summary>One record by file name — a single stat, not a listing.</summary>
    public T? One(string fileName)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var fi = new FileInfo(Path.Combine(_dir, fileName));
            if (!fi.Exists)
            {
                if (_entries.Remove(fileName)) { _dirty = true; _snapshot = null; ScheduleSave(); }
                return null;
            }
            if (Refresh(fi)) { _dirty = true; _snapshot = null; ScheduleSave(); }
            return _entries.TryGetValue(fi.Name, out var e) ? e.Rec : null;
        }
    }

    /// <summary>Re-read the file unless what we have for it is still trustworthy.
    /// Returns whether anything changed. Stat BEFORE reading: a write that lands
    /// in between leaves a stale stat on fresh content, which the next lookup
    /// notices; the other order would trust stale content.</summary>
    bool Refresh(FileInfo fi)
    {
        var mtime = fi.LastWriteTimeUtc.Ticks;
        var size = fi.Length;
        if (_entries.TryGetValue(fi.Name, out var e) && e.Mtime == mtime && e.Size == size
            && e.Seen - mtime >= Racy.Ticks)
            return false;
        T? rec;
        try { rec = _parse(fi.FullName); }
        catch (IOException) { return false; }                  // mid-write; the next lookup retries
        catch (UnauthorizedAccessException) { return false; }
        _entries[fi.Name] = new Entry(mtime, size, DateTime.UtcNow.Ticks, rec);
        return true;
    }

    /* ── persistence ─────────────────────────────────────────────── */

    void EnsureLoaded()
    {
        if (_loaded) return;
        _loaded = true;
        if (_file is null || !File.Exists(_file)) return;
        try
        {
            var disk = JsonSerializer.Deserialize<Disk>(File.ReadAllBytes(_file), Json);
            if (disk is null || disk.Format != Format || disk.Build != Build) return;
            foreach (var r in disk.Rows)
                if (r.File.Length > 0) _entries[r.File] = new Entry(r.Mtime, r.Size, r.Seen, r.Rec);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or NotSupportedException)
        {
            _entries.Clear();   // a half-read cache is worse than none
        }
    }

    void ScheduleSave()
    {
        if (_file is null) return;
        _saveTimer ??= new Timer(_ => Save(), null, Timeout.Infinite, Timeout.Infinite);
        _saveTimer.Change(SaveDelay, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Write the cache out now. Safe to call at any time and from any
    /// thread; a failure is swallowed and retried at the next change, since the
    /// cache is an optimisation and must never be the reason a request fails.</summary>
    public void Save()
    {
        if (_file is null) return;
        lock (_saveGate)
        {
            Disk disk;
            lock (_gate)
            {
                if (!_dirty) return;
                _dirty = false;
                disk = new Disk
                {
                    Format = Format,
                    Build = Build,
                    Rows = _entries.OrderBy(e => e.Key, StringComparer.OrdinalIgnoreCase)
                        .Select(e => new Row { File = e.Key, Mtime = e.Value.Mtime, Size = e.Value.Size,
                                               Seen = e.Value.Seen, Rec = e.Value.Rec }).ToList(),
                };
            }
            try
            {
                var dir = Path.GetDirectoryName(_file)!;
                Directory.CreateDirectory(dir);
                var ignore = Path.Combine(dir, ".gitignore");
                if (!File.Exists(ignore))
                    File.WriteAllText(ignore, "# Derived from the records; safe to delete.\n*\n");
                // Write beside it and rename over: a crash mid-write leaves the
                // old cache, never half of a new one.
                var tmp = _file + ".tmp";
                File.WriteAllBytes(tmp, JsonSerializer.SerializeToUtf8Bytes(disk, Json));
                File.Move(tmp, _file, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                lock (_gate) _dirty = true;
            }
        }
    }

    public void Dispose()
    {
        lock (_gate) { _saveTimer?.Dispose(); _saveTimer = null; }
        Save();
    }
}

/// <summary>
/// The caches in play, one per folder. Looked up by folder so the
/// <c>Load*</c> helpers keep taking the directory they always did; a store
/// <see cref="Attach"/>es its folders when it opens, which is what gives them a
/// file on disk. A folder nobody attached is cached in memory only.
/// </summary>
static class Records
{
    static readonly ConcurrentDictionary<string, RecordCache<Bug>> _bugs = new(StringComparer.OrdinalIgnoreCase);
    static readonly ConcurrentDictionary<string, RecordCache<BacklogItem>> _backlog = new(StringComparer.OrdinalIgnoreCase);

    static string Key(string dir) => Path.GetFullPath(dir);

    static RecordCache<Bug> NewBugs(string dir, string? file) =>
        new(dir, new[] { "BUG-*.md" }, Bug.Parse, file);

    static RecordCache<BacklogItem> NewBacklog(string dir, string? file) =>
        new(dir, BacklogItem.Prefixes.Values.Select(p => $"{p}-*.md").ToArray(), BacklogItem.Parse, file);

    public static RecordCache<Bug> Bugs(string dir) => _bugs.GetOrAdd(Key(dir), d => NewBugs(d, null));
    public static RecordCache<BacklogItem> Backlog(string dir) => _backlog.GetOrAdd(Key(dir), d => NewBacklog(d, null));

    /// <summary>Give a store's folders their persisted caches, replacing any an
    /// earlier incarnation of the store left behind.</summary>
    public static void Attach(Store s)
    {
        var cacheDir = Path.Combine(s.ConfigDir, "cache");
        if (s.HasBugs)
            Replace(_bugs, Key(s.BugsDir), NewBugs(s.BugsDir, Path.Combine(cacheDir, "bugs.json")));
        if (s.HasBacklog)
            Replace(_backlog, Key(s.BacklogDir), NewBacklog(s.BacklogDir, Path.Combine(cacheDir, "backlog.json")));
    }

    /// <summary>Flush and forget a store's caches — it is being closed or rebuilt.</summary>
    public static void Release(Store s)
    {
        if (s.HasBugs && _bugs.TryRemove(Key(s.BugsDir), out var b)) b.Dispose();
        if (s.HasBacklog && _backlog.TryRemove(Key(s.BacklogDir), out var k)) k.Dispose();
    }

    static void Replace<T>(ConcurrentDictionary<string, RecordCache<T>> map, string key, RecordCache<T> next)
        where T : class
    {
        map.AddOrUpdate(key, next, (_, prev) => { prev.Dispose(); return next; });
    }
}

/// <summary>
/// The backlog's parent/child structure, built once per snapshot of the store
/// rather than rediscovered by a linear scan on every hop up or down the tree.
/// Keyed on the list instance <see cref="RecordCache{T}.All"/> returns, which only
/// changes when a record does, so the index is rebuilt exactly when it could be stale.
/// </summary>
sealed class BacklogIndex
{
    static readonly ConditionalWeakTable<IReadOnlyList<BacklogItem>, BacklogIndex> Built = new();

    public Dictionary<int, BacklogItem> ById { get; } = new();
    public ILookup<int, BacklogItem> ByParent { get; }

    BacklogIndex(IReadOnlyList<BacklogItem> all)
    {
        // First wins, as `FirstOrDefault(i => i.Id == id)` always did: an id used
        // twice is a hand-edit mistake, and the answer should not depend on who asks.
        foreach (var item in all) ById.TryAdd(item.Id, item);
        ByParent = all.ToLookup(i => i.Parent);
    }

    public static BacklogIndex For(IReadOnlyList<BacklogItem> all) => Built.GetValue(all, a => new BacklogIndex(a));
}
