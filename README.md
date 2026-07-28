# BugDesk

A local, markdown-backed bug tracker for SharpGenerals. Built to end the
coordination/authorship problem of shared GitHub Issues: bugs are plain markdown
files that the AI edits directly and a human triages in a FlexDesk UI — no API
round-trip, no `gh`-token authorship ambiguity, git-tracked alongside the code.

```
bugdesk/
  server/   C# bridge (.NET 10 minimal API): serves ui/ + JSON API over the store
  ui/       FlexDesk shell (forked from ../ticketdesk), rewired to the bridge
  run.sh    dotnet run wrapper
```

The **store** is `../SharpGenerals/bugs/*.md` (one file per bug). That is the
source of truth — see `SharpGenerals/bugs/SCHEMA.md`. Override with `BUGDESK_BUGS`.

## Run

```bash
./run.sh                      # http://127.0.0.1:8766
```

Requires the .NET SDK (`dotnet`, tested on 10.0.100). No Node/build step for the
UI — FlexDesk is vendored and loaded through an import map.

## API

Same-origin JSON, backed by the markdown files:

| method | path | purpose |
|---|---|---|
| GET  | `/api/bugs` | list (summaries, sorted by priority) |
| GET  | `/api/bugs/{id}` | one bug: frontmatter + description + parsed comments |
| POST | `/api/bugs/{id}` | update frontmatter (status/severity/assignee/subsystem/labels/…) |
| POST | `/api/bugs/{id}/comments` | append a `### date · author` comment |
| GET  | `/api/meta` | aggregate counts by status/subsystem/assignee/severity |

Every other `/api/<method>` returns `{ok:true,result:{ok:true}}` so the FlexDesk
shell boots.

## Lifecycle

Four states; `assignee` is **derived from status** by the bridge (there is no
"unassigned"):

```
open ──▶ investigation ⇄ testing ──▶ closed
        (closed may reopen to investigation on regression)
```

| status | stage | owner | meaning |
|---|---|---|---|
| `open` | 0 | norman | first entry — **one-way out**, nothing returns here |
| `investigation` | 1 | claude | on claude to investigate and fix |
| `testing` | 2 | norman | on norman to test the fix in a live game |
| `closed` | 3 | norman | norman closed it |

The queue's left rail filters on the store fields the summary API exposes —
notably **"Needs my reply"** = bugs whose last comment was claude's
(`lastCommentAuthor == "claude"`), so norman hasn't responded yet.

## Authorship

The two authors are `claude` and `norman`. Every comment is a
`### YYYY-MM-DD · <author>` block — that is the whole point: you always know who
said what. GitHub is no longer linked; the store is the sole source of truth.
