/// <summary>
/// The two shapes the fulltext search works in — see the <c>/api/search</c>
/// endpoint and its <c>Match</c>/<c>Snippet</c> helpers in Program.cs.
///
/// <para>
/// Their own file because Program.cs is one long method (BugDeskServer.Run),
/// and a type cannot be declared inside a method.
/// </para>
/// </summary>

/// One record flattened into the fields a search looks at.
record SearchDoc(string Store, int Id, string Ref, string Type, string Title,
                 string Status, string Assignee, string Updated,
                 string Description, string Extra, List<Comment> Comments);

/// A record that matched, with WHERE the best match was and a line of context.
record SearchHit(SearchDoc Doc, int Rank, string Where, string Snippet);

