/**
 * record-fixtures.mjs — the inputs the record-format tests share.
 *
 * WHY A SHARED FILE. Three of the four grammars in this release exist TWICE: once
 * in C# (`server/Markdown.cs`, `server/RecordHistory.cs`, `server/RecordRef.cs`)
 * and once in JS (`ui/js/ticketdesk/refs.js`, `links.js`). There is no C# test
 * project — `BugDesk.Server.csproj` has zero `<PackageReference>` and `npm test`
 * never invokes dotnet — so the only thing that can hold the two halves together
 * is running both over the SAME inputs and comparing what comes out.
 *
 * Regex SOURCE TEXT is never compared across the two languages: the C# patterns
 * use named groups and the JS twins use numbered ones, so textual equality is
 * impossible and would mean nothing even if it held. The tests compare
 * BEHAVIOUR — match / no-match, and the fields that come out.
 */

/**
 * Comment headers: `[input, expectedAuthor | null]`, `null` meaning the header
 * pattern must not match at all.
 *
 * Row 5 is the bug this release fixes: `_` was in the author's negated class, so
 * `hans_agent` — exactly the shape `ProjectConfig.AgentNameFor` generates —
 * matched NOTHING, and the comment was folded into the previous one's body.
 * Row 7 matched before the fix and still matches; any prose claiming otherwise is
 * wrong. Row 8 is the input that still does not parse cleanly, which is why a
 * note has to be bracketed.
 */
export const COMMENT_HEADERS = [
    ['### 2026-07-27 · agent', 'agent'],
    ['### 2026-07-27 · agent (fixed)', 'agent'],
    ['### 2026-07-27 · agent _(imported)_', 'agent'],
    ['### 2026-07-27 · agent (fixed) _(imported)_', 'agent'],
    ['### 2026-07-27 · hans_agent', 'hans_agent'],              // THE BUG
    ['### 2026-07-27 · hans_agent (fixed) _(imported)_', 'hans_agent'],
    ['### 2026-07-27 · agent_(imported)_', 'agent'],            // matched before too
    ['### 2026-07-27 · agent after re-test', 'agent after re-test'],
    ['### 2026-07-27 - agent', null],                           // hyphen, not U+00B7
    ['#### not a header', null],
];

/**
 * History lines: `[input, expected | null]`, where `expected` is what
 * `RecordHistory.Parse` yields for that one line —
 * `{date, actor, field, from, to}` for a transition, `{note}` for a note — and
 * `null` means Parse produces NO row for it (a blank, a heading, a placeholder).
 *
 * A line the entry pattern rejects is a NOTE, never nothing: that is invariant 7,
 * and dropping a line a person can read is the exact failure class the comment
 * header fix above exists to end. So `status: open -> investigation` written
 * flush-left comes back as a note — the separate assertion that the ENTRY pattern
 * does not match it is what pins the collision the mandatory `- ` bullet prevents.
 */
export const HISTORY_LINES = [
    ['- 2026-09-12 · norman_agent · status: investigation -> testing',
     { date: '2026-09-12', actor: 'norman_agent', field: 'status', from: 'investigation', to: 'testing' }],
    ['- 2026-09-12 · hans_agent · assignee: (unset) -> priya',
     { date: '2026-09-12', actor: 'hans_agent', field: 'assignee', from: '', to: 'priya' }],
    ['- 2026-09-12 · a · reporter: norman -> (unset)',
     { date: '2026-09-12', actor: 'a', field: 'reporter', from: 'norman', to: '' }],
    ['* 2026-09-12 · a · status: draft -> refined',              // a `*` bullet parses
     { date: '2026-09-12', actor: 'a', field: 'status', from: 'draft', to: 'refined' }],
    ['- 2026-09-12 · a · status: a -> b -> c',                   // binds the LAST arrow
     { date: '2026-09-12', actor: 'a', field: 'status', from: 'a -> b', to: 'c' }],
    ['- 2026-09-12 · a · status: open → closed',                 // → is read, never written
     { date: '2026-09-12', actor: 'a', field: 'status', from: 'open', to: 'closed' }],
    ['- 2026-09-12 · a · title: x -> y',                         // not a tracked field
     { date: '2026-09-12', actor: 'a', field: '', note: 'title: x -> y' }],
    ['- 2026-09-12 · a · reopened by hand',                      // a free-text note
     { date: '2026-09-12', actor: 'a', field: '', note: 'reopened by hand' }],
    ['- 2026-09-12 · reopened by hand',                          // ONE separator — a note
     { date: '', actor: '', field: '', note: '2026-09-12 · reopened by hand' }],
    ['status: open -> investigation',                            // no bullet: a NOTE, not a status
     { date: '', actor: '', field: '', note: 'status: open -> investigation' }],
    ['### 2026-09-12 · a', null],                                // a comment header
    ['_(nothing yet)_', null],                                   // a placeholder
];

/**
 * References: `[token, selfStore, expected {store,id} | null]`.
 *
 * A bare number is STORE-RELATIVE, which is the whole reason `selfStore` is a
 * column: `52` in a bug's links is a bug and in an item's links is an item.
 */
export const REF_TOKENS = [
    ['52', 'bugs', { store: 'bugs', id: 52 }],
    ['52', 'backlog', { store: 'backlog', id: 52 }],
    ['#52', 'bugs', { store: 'bugs', id: 52 }],
    ['  #7  ', 'bugs', { store: 'bugs', id: 7 }],
    ['BUG-0052', 'backlog', { store: 'bugs', id: 52 }],
    ['bug-52', 'bugs', { store: 'bugs', id: 52 }],
    ['STORY-7', 'bugs', { store: 'backlog', id: 7 }],
    ['STORY-9', 'bugs', { store: 'backlog', id: 9 }],            // unpadded is valid
    ['story-0007', 'bugs', { store: 'backlog', id: 7 }],
    ['PROJ-4', 'bugs', { store: 'backlog', id: 4 }],
    ['EPIC-0001', 'bugs', { store: 'backlog', id: 1 }],
    ['TASK-0031', 'backlog', { store: 'backlog', id: 31 }],
    ['', 'bugs', null],
    ['nope', 'bugs', null],
    ['WIDGET-1', 'bugs', null],
    ['STORY-', 'bugs', null],
    ['0', 'bugs', null],
    ['STORY-0000', 'bugs', null],
];

/**
 * Tokens the C# `Refs.Token` pattern MATCHES and `Refs.Parse` still rejects, for
 * a reason the pattern cannot express: an unknown prefix names no store, and a
 * zero id names no record. They are listed rather than derived so that nobody
 * "fixes" the regex to reject them — the rejection belongs in the lookup, where
 * `BacklogItem.Prefixes` is the single source of what a prefix means.
 */
export const REF_TOKENS_REJECTED_AFTER_MATCH = ['WIDGET-1', '0', 'STORY-0000'];

/** What `## History` must look like after four appends, however they were
 *  batched. One blank line after the heading, then the lines, and nothing
 *  else — an extra blank line per append is the regression this pins. */
export const HISTORY_APPEND_EXPECTED = [
    '## History',
    '',
    '- 2026-09-12 · a · status: open -> investigation',
    '- 2026-09-12 · a · status: investigation -> testing',
    '- 2026-09-12 · a · assignee: (unset) -> priya',
    '- 2026-09-12 · a · reporter: norman -> (unset)',
].join('\n');

/** The four changes `HISTORY_APPEND_EXPECTED` is the result of, in the order a
 *  reader of that section sees them. */
export const HISTORY_APPEND_CHANGES = [
    { field: 'status', from: 'open', to: 'investigation' },
    { field: 'status', from: 'investigation', to: 'testing' },
    { field: 'assignee', from: '', to: 'priya' },
    { field: 'reporter', from: 'norman', to: '' },
];

/**
 * A record written BY HAND with empty scalar and list keys. This is a supported
 * shape — `Md.Line` deliberately emits a bare `key:` for an empty value, and the
 * skills tell agents to write these files by hand — and three of the shipped
 * example records carry one.
 *
 * It is a fixture because `Md.GetFrontmatter` read the gap after the colon with
 * `\s*`, and `\s` matches a newline: every empty key returned the FOLLOWING
 * line's text as its value. That fed the "from" side of `## History` entries
 * ("assignee: reporter: -> hans_agent") and the existing-links list a
 * duplicate-of merge appends to, which wrote a fabricated "created: 2026-09-01"
 * into a record's own `links:`.
 */
export const BARE_KEY_RECORD = [
    '---',
    'id: 42',
    'title: "Bare frontmatter keys, hand written"',
    'status: open',
    'assignee:',
    'reporter:',
    'labels:',
    'links:',
    'created: 2026-09-01',
    'updated: 2026-09-01',
    '---',
    '',
    '## Description',
    '',
    'body',
    '',
].join('\n');

/** `key -> the value GetFrontmatter must read` out of `BARE_KEY_RECORD`. An
 *  empty key reads as the empty string, never as the next line. */
export const BARE_KEY_VALUES = [
    ['status', 'open'],
    ['assignee', ''],
    ['reporter', ''],
    ['labels', ''],
    ['links', ''],
    ['created', '2026-09-01'],
];
