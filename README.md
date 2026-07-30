# BugDesk

A local, markdown-backed bug tracker built to end the coordination/authorship
problem of shared GitHub Issues: bugs are plain markdown files that an AI
coding agent edits directly and a human triages through a tiling UI — no API
round-trip, no `gh`-token authorship ambiguity, git-tracked alongside the code
they describe.

```
bugdesk/
  server/   C# bridge (.NET 10 minimal API): serves ui/ + JSON API over the store
  ui/       Tiling shell + bug-tracker UI, depending on the FlexDesk package
  skills/   /bugs — a Claude Code skill that teaches an agent the file format
  run.sh    dotnet run wrapper
```

`ui/` depends on [FlexDesk](https://github.com/nor-os/FlexDesk) (vendored at
`ui/vendor/flexdesk/`, MIT licensed) for its kernel — event bus, state
machine, the content registry, the host port, taxonomy/entity-catalog
plumbing. The tiling window manager itself (`ui/js/tiling/wm.js` and friends)
stays local: it carries bugdesk-specific behavior FlexDesk's generalized
version doesn't have (tab-opener tracking so Backspace returns to the tab
that opened a drill-down, bug-specific breadcrumb segments), and its chrome
is styled to match the rest of BugDesk's UI rather than FlexDesk's own
default look. See `ui/js/tiling/kind_taxonomy.js` and `install.js` for exactly
where the package boundary sits.

The **store** is a directory of `BUG-NNNN.md` files (one per bug), each a
YAML-frontmatter block plus a `## Description` and `## Comments` section. That
is the source of truth — see [`skills/bugs/SKILL.md`](skills/bugs/SKILL.md)
for the exact format. Defaults to `./bugs` next to `server/`; override with
`BUGDESK_BUGS=/path/to/bugs`. Point it at a `bugs/` directory tracked inside
your own project's repo to keep bug history alongside the code.

## Run

```bash
./run.sh                      # http://127.0.0.1:8766, bugs in ./bugs
./run.sh --seed                # + pre-seed an empty bug store with 10 example bugs
BUGDESK_BUGS=/path/to/bugs ./run.sh
BUGDESK_HUMAN=alice BUGDESK_AGENT=claude ./run.sh
```

`--seed` copies the sample bugs from `examples/bugs/` into the store the first
time — it never touches a store that already has bugs in it, so it's safe to
leave in your usual command if you like. Good for a first look at BugDesk
before you point it at a real project.

Requires the .NET SDK (`dotnet`, tested on 10.0.100). No Node/build step for
the UI — the FlexDesk package is vendored under `ui/vendor/flexdesk/` and
loaded through an import map, same as everything else in `ui/vendor/`.

## API

Same-origin JSON, backed by the markdown files:

| method | path | purpose |
|---|---|---|
| GET  | `/api/bugs` | list (summaries, sorted by priority) |
| GET  | `/api/bugs/{id}` | one bug: frontmatter + description + parsed comments |
| POST | `/api/bugs/{id}` | update frontmatter (status/severity/assignee/subsystem/labels/…) |
| POST | `/api/bugs/{id}/comments` | append a `### date · author` comment |
| GET  | `/api/meta` | aggregate counts by status/subsystem/assignee/severity |
| GET  | `/api/config` | the configured `humanAuthor`/`agentAuthor` (see Authorship) |

Every other `/api/<method>` returns `{ok:true,result:{ok:true}}` so the shell
boots and renders its empty states.

## Lifecycle

Four states. `assignee` is **explicit** — set by whoever last touched the bug
(the UI's reassign control, or the agent moving it along) — never derived from
`status`, so there's always a clear "whose court is this in."

```
open ──▶ investigation ⇄ testing ──▶ closed
        (closed may reopen to investigation on regression)
```

| status | stage | typical owner | meaning |
|---|---|---|---|
| `open` | 0 | human | first entry — **one-way out**, nothing returns here |
| `investigation` | 1 | agent | on the agent to investigate and fix |
| `testing` | 2 | human | on the human to verify the fix |
| `closed` | 3 | human | verified and done |

The queue's left rail filters on the fields the summary API exposes — notably
**"Needs my reply"** = bugs whose last comment was the agent's
(`lastCommentAuthor == <agentAuthor>`), so the human hasn't responded yet.

## Authorship

BugDesk assumes exactly two roles — a human who files/triages/tests bugs
through this UI, and an agent who investigates them — but neither name is
fixed. Configure them with environment variables (both optional, both
generic by default):

```bash
BUGDESK_HUMAN=alice   # default: "reviewer"
BUGDESK_AGENT=claude  # default: "agent"
```

The server exposes both via `GET /api/config`; the UI fetches that once at
boot, before anything else renders, so every default assignee, comment
placeholder, and filter ("On me", "On \<agent\>", "Needs my reply") reflects
whatever you configured. Every comment is a `### YYYY-MM-DD · <author>` block
— that is the whole point of the format: you always know who said what,
without depending on GitHub's issue authorship or a `gh` token.

## Claude Code integration

BugDesk ships a `/bugs` skill ([`skills/bugs/SKILL.md`](skills/bugs/SKILL.md))
that teaches Claude the file format, the lifecycle, and how to read/write the
bug store directly — no server or API calls required, just the markdown
files. Install it into whichever project Claude will be investigating bugs
for (not necessarily this repo — BugDesk is usually a sibling tool pointed at
your project's own `bugs/` directory via `BUGDESK_BUGS`):

```bash
# available in every project:
ln -s "$(pwd)/skills/bugs" ~/.claude/skills/bugs

# or scoped to one project:
mkdir -p /path/to/your-project/.claude/skills
ln -s "$(pwd)/skills/bugs" /path/to/your-project/.claude/skills/bugs
```

Then set `BUGDESK_AGENT`/`BUGDESK_HUMAN` (matching however you start the
BugDesk server) so the skill and the UI agree on who's who.

## License

MIT — see [`LICENSE`](LICENSE). Third-party code vendored under `ui/vendor/`
(FlexDesk, CodeMirror, KaTeX, Monaco, Plotly, Material Symbols, …) keeps its
own license; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
