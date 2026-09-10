using System.Text;

/// <summary>
/// One record in the backlog store — <c>EPIC-NNNN.md</c>, <c>STORY-NNNN.md</c> or
/// <c>TASK-NNNN.md</c>.
///
/// <para>
/// Hierarchy is <b>epic → story → task</b>, expressed by a single <c>parent</c>
/// field holding another item's numeric id. A "phase" is NOT a record type: it is
/// a plain milestone label on an EPIC (<c>phase: foundation</c>), which stories
/// and tasks inherit through their ancestors. That keeps the store to three file
/// prefixes while still letting you ask "what is left in the foundation phase".
/// </para>
///
/// <para>
/// IDs are a SINGLE sequence shared by all three prefixes, so <c>parent: 7</c> is
/// unambiguous without also naming the type, and so is a bug's
/// <c>links: [implements STORY-7]</c>.
/// </para>
///
/// <para>
/// Lifecycle: draft → refined → in-progress → review → done, plus the off-ladder
/// terminal <c>dropped</c>. Refinement (see <c>skills/backlog/SKILL.md</c>) is
/// what moves an item from <c>draft</c> to <c>refined</c>: it is the point where
/// the item acquires acceptance criteria, an estimate and a parent.
/// </para>
/// </summary>
class BacklogItem
{
    /// <summary>The ladder, in order. Index === <see cref="Stage"/>.</summary>
    public static readonly string[] Ladder = { "draft", "refined", "in-progress", "review", "done" };

    /// <summary>File prefix per item type. Also the set of legal types.</summary>
    public static readonly Dictionary<string, string> Prefixes = new()
    {
        ["epic"] = "EPIC", ["story"] = "STORY", ["task"] = "TASK",
    };

    public int Id { get; set; }
    public string Type { get; set; } = "story";
    public string Title { get; set; } = "";
    public string Status { get; set; } = "draft";

    /// <summary>Owning item's id, or 0 for a top-level item (every epic, and any
    /// story/task not yet placed — an unparented story is precisely what
    /// refinement exists to resolve).</summary>
    public int Parent { get; set; }

    /// <summary>Milestone label. Authored on epics; see <c>effectivePhase</c> in
    /// the summary for the inherited value.</summary>
    public string Phase { get; set; } = "";

    public string Assignee { get; set; } = "";

    /// <summary>Relative estimate. Empty string means "not estimated", which is
    /// a real and distinct state from "estimated at 0" — refinement checks it.</summary>
    public string Points { get; set; } = "";

    public string Subsystem { get; set; } = "unsorted";
    public List<string> Labels { get; set; } = new();
    public List<string> Links { get; set; } = new();
    public string Created { get; set; } = "";
    public string Updated { get; set; } = "";

    public string Description { get; set; } = "";

    /// <summary>The raw <c>## Acceptance criteria</c> block (markdown, usually a
    /// task list). Empty until the item is refined.</summary>
    public string Acceptance { get; set; } = "";

    public List<Comment> Comments { get; set; } = new();

    public int Stage => Array.IndexOf(Ladder, Status);   // -1 for `dropped` / anything off-ladder
    public bool Done => Status is "done" or "dropped";

    /// <summary>Sort weight: epics before their stories before their tasks.</summary>
    public int TypeOrder => Type switch { "epic" => 0, "story" => 1, _ => 2 };

    public string FileName => $"{Prefixes.GetValueOrDefault(Type, "TASK")}-{Id:D4}.md";

    /// <summary>
    /// Acceptance criteria as checklist rows, so the UI can show "3/5 met" without
    /// re-parsing markdown. Recognises `- [ ]` / `- [x]` at any indentation.
    /// </summary>
    public List<object> Criteria()
    {
        var rows = new List<object>();
        foreach (var line in Acceptance.Split('\n'))
        {
            var s = line.TrimStart();
            if (s.Length < 5 || (s[0] != '-' && s[0] != '*')) continue;
            if (!s[1..].TrimStart().StartsWith("[")) continue;
            var box = s[1..].TrimStart();
            if (box.Length < 3 || box[2] != ']') continue;
            rows.Add(new { done = box[1] is 'x' or 'X', text = box[3..].Trim() });
        }
        return rows;
    }

    /// <param name="phase">The inherited phase, resolved by the caller (which is
    /// the only place that can see the whole store).</param>
    public object ToSummary(string phase, int childCount) => new
    {
        id = Id, type = Type, title = Title, status = Status, stage = Stage,
        parent = Parent, phase = Phase, effectivePhase = phase,
        assignee = Assignee, points = Points, subsystem = Subsystem,
        labels = Labels, links = Links, created = Created, updated = Updated,
        typeOrder = TypeOrder, children = childCount,
        criteria = Criteria(), comments = Comments.Count,
        lastCommentAuthor = Comments.Count > 0 ? Comments[^1].Author : null,
        lastCommentDate = Comments.Count > 0 ? Comments[^1].Date : null,
    };

    public static BacklogItem? Parse(string path)
    {
        if (!Md.Split(File.ReadAllText(path), out var front, out var rest)) return null;

        var item = new BacklogItem();
        foreach (var (k, val) in Md.Fields(front))
        {
            switch (k)
            {
                case "id": int.TryParse(val, out var id); item.Id = id; break;
                case "type": item.Type = val.ToLowerInvariant(); break;
                case "title": item.Title = val; break;
                case "status": item.Status = val; break;
                case "parent": item.Parent = ParseRef(val); break;
                case "phase": item.Phase = val; break;
                case "assignee": item.Assignee = val; break;
                case "points": item.Points = val; break;
                case "subsystem": item.Subsystem = val; break;
                case "created": item.Created = val; break;
                case "updated": item.Updated = val; break;
                case "labels": item.Labels = Md.List(val); break;
                case "links": item.Links = Md.List(val); break;
            }
        }
        // The filename is authoritative for the type: a `type:` line that
        // disagrees with the prefix would otherwise make the same record answer
        // to two different types depending on who asked.
        var name = Path.GetFileName(path);
        foreach (var (type, prefix) in Prefixes)
            if (name.StartsWith(prefix + "-", StringComparison.OrdinalIgnoreCase)) item.Type = type;

        var content = Md.ContentBlock(rest);
        var ai = content.IndexOf("## Acceptance criteria", StringComparison.OrdinalIgnoreCase);
        if (ai >= 0)
        {
            item.Acceptance = content[(ai + "## Acceptance criteria".Length)..].Trim();
            content = content[..ai];
        }
        item.Description = Md.StripHeading(content, "## Description").Trim();
        item.Comments = Md.Comments(rest);
        return item;
    }

    /// <summary>
    /// A parent/link target, written either bare ("7") or prefixed ("STORY-7",
    /// "EPIC-0001"). Both forms appear in hand-authored files, so both parse.
    /// </summary>
    public static int ParseRef(string? val)
    {
        var s = (val ?? "").Trim();
        if (s.Length == 0) return 0;
        var dash = s.LastIndexOf('-');
        if (dash >= 0) s = s[(dash + 1)..];
        return int.TryParse(s, out var n) ? n : 0;
    }

    /// <summary>Render a brand-new record. Only used on create; edits patch in place.</summary>
    public string Render()
    {
        var sb = new StringBuilder();
        sb.Append("---\n");
        void Field(string key, string value) => sb.Append(Md.Line(key, value)).Append('\n');
        Field("id", Id.ToString());
        Field("type", Type);
        Field("title", $"\"{Md.Quote(Title)}\"");
        Field("status", Status);
        Field("parent", Parent > 0 ? Parent.ToString() : "");
        Field("phase", Phase);
        Field("assignee", Assignee);
        Field("points", Points);
        Field("subsystem", Subsystem);
        Field("labels", Md.ListValue(Labels));
        Field("links", Md.ListValue(Links));
        Field("created", Created);
        Field("updated", Updated);
        sb.Append("---\n\n## Description\n\n");
        sb.Append(string.IsNullOrWhiteSpace(Description) ? "_(no description provided)_" : Description.Trim());
        sb.Append("\n\n## Acceptance criteria\n\n");
        sb.Append(string.IsNullOrWhiteSpace(Acceptance)
            ? "_(not refined yet)_"
            : Acceptance.Trim());
        sb.Append('\n');
        return sb.ToString();
    }
}
