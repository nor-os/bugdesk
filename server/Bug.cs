/// <summary>
/// One <c>BUG-NNNN.md</c> file in the bug store.
/// <para>
/// Lifecycle: open → investigation ⇄ testing → closed. See the README and
/// <c>skills/bugs/SKILL.md</c> for the authored format; this class only reads
/// and writes it.
/// </para>
/// </summary>
class Bug
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Status { get; set; } = "open";
    public string Severity { get; set; } = "medium";
    public string Type { get; set; } = "bug";
    public string Subsystem { get; set; } = "unsorted";
    public string Assignee { get; set; } = "";
    public List<string> Labels { get; set; } = new();

    /// <summary>
    /// Relationships to other records, as "&lt;type&gt; &lt;id&gt;" tokens — e.g. "blocks 47".
    /// <para>
    /// Only the AUTHORED direction is ever stored. The inverse ("#47 is-blocked-by this") is
    /// derived by whoever is reading, so the two files can never drift out of agreement and
    /// removing a link only ever touches one file.
    /// </para>
    /// <para>
    /// A link may also point INTO the backlog with a prefixed target — "implements STORY-7" —
    /// which is how a bug says which backlog item it belongs to. Bare numeric targets mean
    /// another bug, as they always have.
    /// </para>
    /// </summary>
    public List<string> Links { get; set; } = new();

    public string Created { get; set; } = "";
    public string Updated { get; set; } = "";
    public string Description { get; set; } = "";
    public List<Comment> Comments { get; set; } = new();

    // Lifecycle: open → investigation ⇄ testing → closed.
    public int Stage => Status switch
    {
        "open" => 0, "investigation" => 1, "testing" => 2, "closed" => 3, _ => 0
    };
    public int Pri => Severity switch
    {
        "crash" => 1, "high" => 2, "medium" => 3, "low" => 4, _ => 3
    };

    public object ToSummary() => new
    {
        id = Id, title = Title, status = Status, severity = Severity, type = Type,
        subsystem = Subsystem, assignee = Assignee, labels = Labels, links = Links,
        created = Created, updated = Updated, stage = Stage, pri = Pri,
        comments = Comments.Count,
        // Last comment's author/date (or null) so the UI can build a
        // "needs my reply" filter from the summary list alone.
        lastCommentAuthor = Comments.Count > 0 ? Comments[^1].Author : null,
        lastCommentDate = Comments.Count > 0 ? Comments[^1].Date : null
    };

    public static Bug? Parse(string path)
    {
        if (!Md.Split(File.ReadAllText(path), out var front, out var rest)) return null;

        var bug = new Bug();
        foreach (var (k, val) in Md.Fields(front))
        {
            switch (k)
            {
                case "id": int.TryParse(val, out var id); bug.Id = id; break;
                case "title": bug.Title = val; break;
                case "status": bug.Status = val; break;
                case "severity": bug.Severity = val; break;
                case "type": bug.Type = val; break;
                case "subsystem": bug.Subsystem = val; break;
                case "assignee": bug.Assignee = val; break;
                case "created": bug.Created = val; break;
                case "updated": bug.Updated = val; break;
                case "labels": bug.Labels = Md.List(val); break;
                case "links": bug.Links = Md.List(val); break;
            }
        }

        bug.Description = Md.StripHeading(Md.ContentBlock(rest), "## Description").Trim();
        bug.Comments = Md.Comments(rest);
        return bug;
    }
}
