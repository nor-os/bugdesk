using System.Globalization;
using System.Text;

/// <summary>
/// <c>projects.toml</c> — which projects this BugDesk knows, where each one's
/// stores are, where the one global tracker lives, and who you are.
///
/// <code>
/// [user]
/// name = "norman"
///
/// [tracker]                         # global: not tied to any project
/// path = 'C:\Users\Norman\AppData\Roaming\BugDesk\bugdesk'
/// enabled = false                   # optional: keep the path, hide the section
///
/// [projects.bugdesk]
/// bugs    = 'C:\Users\Norman\repos\bugdesk\bugs'
/// backlog = 'C:\Users\Norman\repos\bugdesk\backlog'
///
/// [projects.tables]                 # only a backlog: no Bugs chip there
/// backlog = 'C:\Users\Norman\repos\tables\backlog'
/// </code>
///
/// <para>
/// It lives in the BugDesk checkout and is git-ignored: it names folders on THIS
/// machine, which no other checkout shares. It is meant to be edited by hand, so
/// it is re-read whenever it changes on disk, and BugDesk's own writes (adding a
/// project from the switcher, setting your name) are LINE edits that leave every
/// comment and every other table exactly as the person wrote them. Regenerating
/// the file from a model would be simpler and would silently delete their notes.
/// </para>
///
/// <para>
/// The parser reads the subset of TOML the file needs — tables, dotted keys,
/// basic and literal strings, booleans, numbers, comments — and names the line of
/// anything else rather than guessing at it. A file that stops parsing keeps the
/// last good reading in force: a half-typed edit must not make every project
/// vanish from under an open browser.
/// </para>
/// </summary>
sealed class ProjectsFile
{
    public sealed record ProjectDef(string Name, string? Bugs, string? Backlog, string? Config, string? Attachments);

    public sealed record Model(
        string? UserName,
        string? AgentName,
        string? TrackerPath,
        bool TrackerEnabled,
        IReadOnlyList<ProjectDef> Projects)
    {
        public static readonly Model Empty = new(null, null, null, true, Array.Empty<ProjectDef>());
    }

    readonly object _gate = new();
    Model _model = Model.Empty;
    DateTime _stamp = DateTime.MinValue;
    long _length = -1;

    public string Path { get; }

    /// <summary>Why the file on disk could not be read, or null. The model in
    /// force is then the last one that could.</summary>
    public string? Error { get; private set; }

    public ProjectsFile(string path) => Path = System.IO.Path.GetFullPath(path);

    public bool Exists => File.Exists(Path);

    /// <summary>The file as it stands now — re-read when it has changed on disk.
    /// One stat per call, which is nothing next to the markdown every request
    /// already reads.</summary>
    public Model Current
    {
        get
        {
            lock (_gate)
            {
                var info = new FileInfo(Path);
                var stamp = info.Exists ? info.LastWriteTimeUtc : DateTime.MinValue;
                var length = info.Exists ? info.Length : -1;
                if (stamp == _stamp && length == _length) return _model;
                _stamp = stamp;
                _length = length;
                if (!info.Exists) { _model = Model.Empty; Error = null; return _model; }
                try
                {
                    _model = Interpret(Parse(File.ReadAllText(Path)));
                    Error = null;
                }
                catch (FormatException ex) { Error = ex.Message; }
                return _model;
            }
        }
    }

    /// <summary>A path from the file, resolved against the file's own folder
    /// when relative — the only anchor that means the same thing to the person
    /// editing it and to the server reading it.</summary>
    public string Resolve(string path) =>
        System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Path)!, path));

    // ---- writing -----------------------------------------------------------

    /// <summary>Create the file with this content, unless it already exists.</summary>
    public void CreateIfMissing(string content)
    {
        lock (_gate)
        {
            if (File.Exists(Path)) return;
            File.WriteAllText(Path, content);
        }
    }

    public void AddProject(string name, string? bugs, string? backlog)
    {
        var sb = new StringBuilder();
        sb.Append('\n').Append("[projects.").Append(Key(name)).Append("]\n");
        if (!string.IsNullOrEmpty(bugs)) sb.Append("bugs = ").Append(Str(bugs)).Append('\n');
        if (!string.IsNullOrEmpty(backlog)) sb.Append("backlog = ").Append(Str(backlog)).Append('\n');
        Edit(lines =>
        {
            while (lines.Count > 0 && lines[^1].Trim().Length == 0) lines.RemoveAt(lines.Count - 1);
            lines.AddRange(sb.ToString().Split('\n')[..^1]);
        });
    }

    /// <summary>Remove one project's table — and the comment lines directly above
    /// it, which describe it and would otherwise be left describing nothing. The
    /// folders it named are not touched.</summary>
    public bool RemoveProject(string name)
    {
        var removed = false;
        Edit(lines =>
        {
            var start = FindTable(lines, "projects", name);
            if (start < 0) return;
            var end = start + 1;
            while (end < lines.Count && !IsHeader(lines[end])) end++;
            // Trailing comments right before the NEXT table belong to that table.
            while (end > start + 1 && lines[end - 1].TrimStart().StartsWith('#')) end--;
            var top = start;
            while (top > 0 && lines[top - 1].TrimStart().StartsWith('#')) top--;
            lines.RemoveRange(top, end - top);
            // Collapse the blank lines the removal leaves behind.
            while (top > 0 && top < lines.Count && lines[top].Trim().Length == 0 && lines[top - 1].Trim().Length == 0)
                lines.RemoveAt(top);
            removed = true;
        });
        return removed;
    }

    /// <summary>Set <c>[user] name</c> (and <c>agent</c> when given), creating the
    /// table at the top of the file if it is not there.</summary>
    public void SetUser(string name, string? agent)
    {
        Edit(lines =>
        {
            var at = FindTable(lines, "user");
            if (at < 0)
            {
                // Before the first table, so the file's own header comment stays first.
                at = lines.FindIndex(IsHeader);
                if (at >= 0) lines.InsertRange(at, new[] { "[user]", "" });
                else { lines.Add(""); lines.Add("[user]"); at = lines.Count - 1; }
            }
            SetKey(lines, at, "name", Str(name));
            if (!string.IsNullOrWhiteSpace(agent)) SetKey(lines, at, "agent", Str(agent!));
        });
    }

    void Edit(Action<List<string>> change)
    {
        lock (_gate)
        {
            var text = File.Exists(Path) ? File.ReadAllText(Path) : "";
            var crlf = text.Contains("\r\n");
            var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
            if (lines.Count > 0 && lines[^1].Length == 0) lines.RemoveAt(lines.Count - 1);
            change(lines);
            var next = string.Join('\n', lines) + "\n";
            File.WriteAllText(Path, crlf ? next.Replace("\n", "\r\n") : next);
        }
    }

    static void SetKey(List<string> lines, int header, string key, string value)
    {
        var end = header + 1;
        while (end < lines.Count && !IsHeader(lines[end])) end++;
        for (var i = header + 1; i < end; i++)
        {
            var (k, _) = SplitKeyValue(lines[i], i + 1);
            if (k is not null && k.Count == 1 && k[0] == key) { lines[i] = $"{key} = {value}"; return; }
        }
        // After the table's last key, not after its trailing blank lines.
        var at = end;
        while (at > header + 1 && lines[at - 1].Trim().Length == 0) at--;
        lines.Insert(at, $"{key} = {value}");
    }

    static int FindTable(List<string> lines, params string[] path)
    {
        for (var i = 0; i < lines.Count; i++)
        {
            if (!IsHeader(lines[i])) continue;
            List<string> segs;
            try { segs = ParseHeader(StripComment(lines[i], i + 1).Trim(), i + 1); }
            catch (FormatException) { continue; }
            if (segs.Count == path.Length && segs.Zip(path).All(p => p.First == p.Second)) return i;
        }
        return -1;
    }

    static bool IsHeader(string line) => line.TrimStart().StartsWith('[');

    /// <summary>A key as TOML wants it: bare when it can be, quoted otherwise.</summary>
    static string Key(string name) =>
        name.Length > 0 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ? name : Str(name);

    /// <summary>A string value. Literal ('…') when possible, because that is the
    /// form in which a Windows path reads the way the person typed it.</summary>
    static string Str(string s)
    {
        if (!s.Contains('\'') && !s.Any(char.IsControl)) return $"'{s}'";
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            sb.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                '\t' => "\\t",
                '\r' => "\\r",
                _ when char.IsControl(c) => $"\\u{(int)c:X4}",
                _ => c.ToString(),
            });
        }
        return sb.Append('"').ToString();
    }

    // ---- reading -----------------------------------------------------------

    static Model Interpret(List<(List<string> Key, string Value)> pairs)
    {
        string? user = null, agent = null, tracker = null;
        var trackerEnabled = true;
        var order = new List<string>();
        var fields = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var (key, value) in pairs)
        {
            if (key is ["user", "name"]) user = value;
            else if (key is ["user", "agent"]) agent = value;
            else if (key is ["tracker", "path"]) tracker = value;
            else if (key is ["tracker", "enabled"]) trackerEnabled = value.Trim().ToLowerInvariant() is not ("false" or "no" or "off" or "0");
            else if (key.Count == 3 && key[0] == "projects")
            {
                if (!fields.TryGetValue(key[1], out var f))
                {
                    fields[key[1]] = f = new(StringComparer.Ordinal);
                    order.Add(key[1]);
                }
                f[key[2]] = value;
            }
        }
        var projects = order.Select(n =>
        {
            var f = fields[n];
            string? Get(string k) => f.TryGetValue(k, out var v) && v.Trim().Length > 0 ? v.Trim() : null;
            return new ProjectDef(n, Get("bugs"), Get("backlog"), Get("config"), Get("attachments"));
        }).ToList();
        return new Model(Blank(user), Blank(agent), Blank(tracker), trackerEnabled, projects);

        static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }

    /// <summary>Every <c>key = value</c> in the file, each key the full dotted
    /// path including the table it sits in. Throws FormatException naming the
    /// line for anything outside the supported subset.</summary>
    static List<(List<string> Key, string Value)> Parse(string text)
    {
        var result = new List<(List<string>, string)>();
        var table = new List<string>();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (var n = 0; n < lines.Length; n++)
        {
            var lineNo = n + 1;
            var line = StripComment(lines[n], lineNo).Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith("[["))
                throw new FormatException($"line {lineNo}: arrays of tables ([[…]]) are not supported here");
            if (line.StartsWith('['))
            {
                table = ParseHeader(line, lineNo);
                continue;
            }
            var (key, raw) = SplitKeyValue(line, lineNo);
            if (key is null) throw new FormatException($"line {lineNo}: expected `key = value` or a [table]");
            result.Add((table.Concat(key).ToList(), ParseValue(raw!, lineNo)));
        }
        return result;
    }

    static List<string> ParseHeader(string line, int lineNo)
    {
        if (!line.EndsWith(']')) throw new FormatException($"line {lineNo}: a table header must end with ]");
        var (segs, rest) = ParseKey(line[1..^1], lineNo);
        if (rest.Trim().Length > 0) throw new FormatException($"line {lineNo}: unexpected '{rest.Trim()}' in table header");
        return segs;
    }

    static (List<string>? Key, string? Raw) SplitKeyValue(string line, int lineNo)
    {
        var stripped = StripComment(line, lineNo).Trim();
        if (stripped.Length == 0 || stripped.StartsWith('[')) return (null, null);
        var (segs, rest) = ParseKey(stripped, lineNo);
        rest = rest.TrimStart();
        if (!rest.StartsWith('=')) throw new FormatException($"line {lineNo}: expected '=' after the key");
        return (segs, rest[1..].Trim());
    }

    /// <summary>A dotted key — bare, "basic" or 'literal' segments — and whatever
    /// follows it.</summary>
    static (List<string> Segs, string Tail) ParseKey(string s, int lineNo)
    {
        var segs = new List<string>();
        var i = 0;
        while (true)
        {
            while (i < s.Length && s[i] is ' ' or '\t') i++;
            if (i >= s.Length) throw new FormatException($"line {lineNo}: missing key");
            if (s[i] is '"' or '\'')
            {
                var (value, next) = ReadString(s, i, lineNo);
                segs.Add(value);
                i = next;
            }
            else
            {
                var start = i;
                while (i < s.Length && (char.IsAsciiLetterOrDigit(s[i]) || s[i] is '_' or '-')) i++;
                if (i == start) throw new FormatException($"line {lineNo}: invalid character '{s[i]}' in a key");
                segs.Add(s[start..i]);
            }
            while (i < s.Length && s[i] is ' ' or '\t') i++;
            if (i < s.Length && s[i] == '.') { i++; continue; }
            return (segs, s[i..]);
        }
    }

    static string ParseValue(string raw, int lineNo)
    {
        if (raw.StartsWith("\"\"\"") || raw.StartsWith("'''"))
            throw new FormatException($"line {lineNo}: multi-line strings are not supported here");
        if (raw.StartsWith('"') || raw.StartsWith('\''))
        {
            var (value, next) = ReadString(raw, 0, lineNo);
            if (raw[next..].Trim().Length > 0)
                throw new FormatException($"line {lineNo}: unexpected text after the string");
            return value;
        }
        if (raw is "true" or "false") return raw;
        if (double.TryParse(raw.Replace("_", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out _)) return raw;
        if (raw.StartsWith('[') || raw.StartsWith('{'))
            throw new FormatException($"line {lineNo}: arrays and inline tables are not supported here");
        throw new FormatException($"line {lineNo}: a value must be a quoted string — for a path, 'C:\\like\\this'");
    }

    /// <summary>A basic ("…", with escapes) or literal ('…', verbatim) string
    /// starting at <paramref name="at"/>; returns it and the index after it.</summary>
    static (string Value, int Next) ReadString(string s, int at, int lineNo)
    {
        var quote = s[at];
        var sb = new StringBuilder();
        for (var i = at + 1; i < s.Length; i++)
        {
            var c = s[i];
            if (c == quote) return (sb.ToString(), i + 1);
            if (quote == '"' && c == '\\')
            {
                if (++i >= s.Length) break;
                switch (s[i])
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u' when i + 4 < s.Length:
                        sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; break;
                    default:
                        throw new FormatException(
                            $"line {lineNo}: '\\{s[i]}' is not a valid escape — for a Windows path use single quotes: 'C:\\path'");
                }
                continue;
            }
            sb.Append(c);
        }
        throw new FormatException($"line {lineNo}: unterminated string");
    }

    /// <summary>The line without its comment — a <c>#</c> outside any string.</summary>
    static string StripComment(string line, int lineNo)
    {
        char? quote = null;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quote is null)
            {
                if (c == '#') return line[..i];
                if (c is '"' or '\'') quote = c;
            }
            else if (quote == '"' && c == '\\') i++;
            else if (c == quote) quote = null;
        }
        return line;
    }
}
