using System.Diagnostics;
using System.Text.RegularExpressions;

/// <summary>
/// The next id for a new record — and why it is not simply <c>max(files) + 1</c>.
///
/// <para>
/// The folder is not the whole truth about which ids are taken. Two branches (or
/// two machines) that each file a bug before merging both see the same folder and
/// both write <c>BUG-0016.md</c>; git reports an add/add conflict at best, and at
/// worst one record replaces the other. And a record that was deleted or moved
/// away leaves a gap that <c>max + 1</c> fills again, so its id comes back meaning
/// something else while old commits, comments and links still mean the first one
/// (BUG-0015: this store's own BUG-0011..0015 reused ids that had belonged to
/// records moved to another repo).
/// </para>
///
/// <para>
/// So the next id is one above every id this checkout has EVER SEEN for the store:
/// the files on disk, every file of that kind that was ever added on any ref git
/// knows — local branches, fetched remote branches, history including deletions —
/// and the store's trash. That is one <c>git log --all</c>, run only when a record
/// is created. It cannot see a branch that was never pushed or fetched; that case
/// still ends in an add/add conflict, which is loud rather than silent. File names
/// are unchanged: <c>BUG-NNNN.md</c> written by hand keeps working.
/// </para>
///
/// <para>
/// Git is optional. Not installed, not a repository, slow beyond
/// <see cref="GitTimeout"/>: the answer falls back to what the folder and the
/// trash know, which is what BugDesk did before.
/// </para>
/// </summary>
static class RecordIds
{
    static readonly TimeSpan GitTimeout = TimeSpan.FromSeconds(5);

    /// <param name="dir">the store folder</param>
    /// <param name="prefixes">file prefixes sharing one sequence — <c>BUG</c>, or every backlog prefix</param>
    /// <param name="trashDir">where deleted records of this store went (may not exist)</param>
    /// <param name="loaded">ids of the records currently loaded, which already covers the folder</param>
    public static int Next(string dir, IEnumerable<string> prefixes, string trashDir, IEnumerable<int> loaded)
    {
        var name = new Regex(@"(?:^|[-/\\])(?:" + string.Join("|", prefixes.Select(Regex.Escape)) + @")-(\d+)\.md$",
            RegexOptions.IgnoreCase);
        int Id(string path) => name.Match(path.Trim()) is { Success: true } m && int.TryParse(m.Groups[1].Value, out var n) ? n : 0;

        var max = loaded.DefaultIfEmpty(0).Max();
        if (Directory.Exists(dir))
            foreach (var f in Directory.EnumerateFiles(dir, "*.md")) max = Math.Max(max, Id(f));
        if (Directory.Exists(trashDir))
            foreach (var f in Directory.EnumerateFiles(trashDir, "*.md")) max = Math.Max(max, Id(f));
        foreach (var path in EverAdded(dir)) max = Math.Max(max, Id(path));
        return max + 1;
    }

    /// <summary>Every path under <paramref name="dir"/> that any commit on any ref
    /// added, or nothing when git cannot answer in time.</summary>
    static IEnumerable<string> EverAdded(string dir)
    {
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        try
        {
            var psi = new ProcessStartInfo("git")
            {
                WorkingDirectory = dir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in new[] { "log", "--all", "--format=", "--name-only", "--diff-filter=A", "--", "." })
                psi.ArgumentList.Add(a);
            using var git = Process.Start(psi);
            if (git is null) return Array.Empty<string>();
            var output = git.StandardOutput.ReadToEndAsync();
            _ = git.StandardError.ReadToEndAsync();   // drained so a chatty stderr cannot block it
            if (!git.WaitForExit(GitTimeout))
            {
                try { git.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return Array.Empty<string>();
            }
            return git.ExitCode == 0
                ? output.Result.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                : Array.Empty<string>();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return Array.Empty<string>();   // no git on PATH
        }
    }
}
