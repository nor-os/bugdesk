# BugDesk

A local, markdown-backed bug tracker **and backlog** built to end the
coordination/authorship problem of shared GitHub Issues: bugs and feature work
are plain markdown files that an AI coding agent edits directly and a human
triages through a tiling UI — no API round-trip, no `gh`-token authorship
ambiguity, git-tracked alongside the code they describe.

![BugDesk's queue view: a filterable bug list with priority/status/assignee columns, a filter rail on the left, and a team inspector on the right](screenshot.png)

```
bugdesk/
  server/    C# bridge (.NET 10 minimal API): serves ui/ + JSON API over both stores
  ui/        Tiling shell + bug/backlog UI, depending on the FlexDesk package
  skills/    /bugs and /backlog — Claude Code skills that teach an agent the formats
  scripts/   sync-flexdesk.mjs — refresh ui/vendor/flexdesk/ from the npm package
  examples/  sample bugs and backlog items for --seed
  run.sh     dotnet run wrapper (Linux/macOS/WSL)
  run.ps1    dotnet run wrapper (Windows PowerShell)
```

## Two stores

| | bugs | backlog |
|---|---|---|
| what it holds | what broke | what you meant to build |
| files | `BUG-NNNN.md` | `EPIC-`/`STORY-`/`TASK-NNNN.md` |
| default location | `./bugs` | `./backlog`, beside the bug store |
| override | `BUGDESK_BUGS` | `BUGDESK_BACKLOG` |
| lifecycle | open → investigation ⇄ testing → closed | draft → refined → in-progress → review → done |
| distinguishing fields | severity, subsystem | parent, phase, points, acceptance criteria |
| skill | [`/bugs`](skills/bugs/SKILL.md) | [`/backlog`](skills/backlog/SKILL.md) |

Both are directories of markdown files — a YAML-frontmatter block plus
`## Description` and `## Comments` sections (the backlog adds
`## Acceptance criteria`). That is the source of truth; the server only reads
and writes those files. Point `BUGDESK_BUGS` at a `bugs/` directory tracked
inside your own project's repo and the backlog follows automatically as its
sibling, so both histories live alongside the code.

Keeping them apart is deliberate: a bug has a severity and a reproduction, an
item has a size and an acceptance criterion, and one record type carrying both
makes every field optional for half the rows.

### The backlog hierarchy

```
EPIC-0001  Auth rewrite            phase: foundation
 ├ STORY-0007  Log in with SSO     parent: 1
 │  ├ TASK-0031  wire OIDC client  parent: 7
 │  └ TASK-0032  session cookie    parent: 7
 └ STORY-0008  Revoke propagation  parent: 1
```

IDs are **one sequence shared by all three prefixes**, which is what makes
`parent: 7` unambiguous without also naming a type — and what lets a bug point
at backlog work with `links: [relates STORY-7]`.

A **phase** is a milestone label carried on an *epic* (`phase: foundation`);
stories and tasks inherit it from their nearest ancestor. So a work package
moves between phases by editing one line in one file, and "what's left in the
foundation phase" is answerable without stamping the same string onto every
descendant.

`refined` is the one status with a definition rather than a convention — an
item is refined when it has acceptance criteria, an estimate and a parent. The
UI lists exactly which of those checks a `draft` still fails, and
[`skills/backlog/REFINEMENT.md`](skills/backlog/REFINEMENT.md) applies the same
five rules. They are defined once, in
`ui/js/ticketdesk/backlog_data.js`'s `REFINEMENT_RULES`.

## Run

```bash
./run.sh                              # http://127.0.0.1:8766, ./bugs + ./backlog
./run.sh --seed                       # + pre-seed empty stores with the examples
BUGDESK_BUGS=/path/to/bugs ./run.sh   # backlog follows as its sibling
BUGDESK_USER=alice ./run.sh           # pick a profile without the first-run prompt
BUGDESK_HUMAN=alice BUGDESK_AGENT=claude ./run.sh
```

On Windows, `run.ps1` is the same wrapper for PowerShell (5.1 or 7):

```powershell
.\run.ps1                     # http://127.0.0.1:8766, .\bugs + .\backlog
.\run.ps1 --seed              # + pre-seed empty stores with the examples
$env:BUGDESK_BUGS='C:\path\to\bugs'; .\run.ps1
$env:BUGDESK_HUMAN='alice'; $env:BUGDESK_AGENT='claude'; .\run.ps1
```

`--seed` copies the samples from `examples/` into the stores the first time. It
seeds each store **independently** and never touches one that already has
records, so it's safe to leave in your usual command — and a repo that already
tracks bugs but has no backlog yet still gets seeded backlog examples.

Requires the .NET SDK (`dotnet`, tested on 10.0.100). No build step for the
UI — it is ES modules served straight off disk through an import map.

## Who you are

**The first time you open BugDesk it asks for your name.** Everything in the
two stores is shared and committed, which is the point; everything about the
person reading them is not. Your name, your saved filters and your window
layout go into a git-ignored file beside the stores, so several people can work
the same repo without overwriting each other on every pull:

```
your-project/
  bugs/BUG-0001.md          tracked
  backlog/EPIC-0001.md      tracked
  .bugdesk/
    .gitignore              "*" — the directory ignores itself, so nothing here
                            can be committed by accident and your project's own
                            .gitignore never needs an entry
    active.json             which profile this checkout is using
    user-alice.json         alice's name, filters and settings
    user-bob.json           bob's
    state-alice/            alice's tile layout and desktops
```

Override the location with `BUGDESK_CONFIG`. Two people sharing one checkout
can each start their own server with `BUGDESK_USER=<name>`, which selects a
profile for that process without repointing `active.json`.

The name is editable afterwards in **Settings › General › Authorship**.

## Authorship

BugDesk assumes exactly two roles — a human who files/triages/tests through
this UI, and an agent who investigates and builds — but neither name is fixed.
Resolution order, highest first:

| source | notes |
|---|---|
| `BUGDESK_HUMAN` / `BUGDESK_AGENT` | environment. Also **suppresses the first-run prompt** — an explicitly configured deployment is not "unconfigured". |
| the per-user profile | what the first-run screen writes. The normal case. |
| `reviewer` / `agent` | generic fallback |

The server exposes the resolved pair via `GET /api/config`; the UI fetches it
before anything else renders, so every default assignee, comment placeholder
and filter ("On me", "On \<agent\>", "Needs my reply") reflects it. Every
comment is a `### YYYY-MM-DD · <author>` block — that is the whole point of the
format: you always know who said what, without depending on GitHub's issue
authorship or a `gh` token.

Because the human's name now usually comes from a profile rather than the
environment, **an agent should read `/api/config` rather than assume `BUGDESK_HUMAN`
being unset means `reviewer`.** Both skills say so.

## API

Same-origin JSON, backed by the markdown files:

| method | path | purpose |
|---|---|---|
| GET  | `/api/bugs` | list (summaries, sorted by priority) |
| GET  | `/api/bugs/{id}` | one bug: frontmatter + description + parsed comments |
| POST | `/api/bugs` | create; the id is assigned server-side |
| POST | `/api/bugs/{id}` | update frontmatter (status/severity/assignee/subsystem/labels/…) |
| POST | `/api/bugs/{id}/comments` | append a `### date · author` comment |
| GET  | `/api/meta` | aggregate counts by status/subsystem/assignee/severity |
| GET  | `/api/backlog` | list, already in **tree order** (epic, its stories, their tasks) |
| GET  | `/api/backlog/{id}` | one item + ancestors + children + criteria + comments |
| POST | `/api/backlog` | create; id assigned server-side, parent validated |
| POST | `/api/backlog/{id}` | update frontmatter, `## Description` or `## Acceptance criteria` |
| POST | `/api/backlog/{id}/comments` | append a comment |
| GET  | `/api/backlog/meta` | counts by status/type/assignee, plus the phase vocabulary |
| GET  | `/api/config` | resolved names, whether a profile exists, the profiles there are |
| POST | `/api/config/user` | adopt a profile by name (what the first-run screen posts) |
| GET/POST | `/api/user/settings` | the UI's own preference bag, stored in the profile |
| GET/POST | `/api/filters` | the user's saved queue filters — **per profile** |
| POST | `/api/attachments` | upload one image (base64), returns its `/attachments/…` URL |

Every other `/api/<method>` returns `{ok:true,result:{ok:true}}` so the shell
boots and renders its empty states.

Tree order is computed **server-side** on purpose: an item's depth is a
function of the whole store, so doing it in the client means every consumer
re-derives it and gets to disagree about orphans and cycles.

## Bug lifecycle

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
(`lastCommentAuthor == <agentAuthor>`), so the human hasn't responded yet. The
rail's second tab carries the backlog's views and phases, and follows whichever
page you're looking at until you pick a tab by hand.

## Backlog lifecycle

```
draft ──▶ refined ──▶ in-progress ──▶ review ──▶ done
                                                  │
  (any state) ──▶ dropped                    reopen to in-progress
```

| status | stage | meaning |
|---|---|---|
| `draft` | 0 | captured, not yet worth starting |
| `refined` | 1 | criteria, estimate, a place in the tree — **anyone can pick it up** |
| `in-progress` | 2 | someone is on it (`assignee` says who) |
| `review` | 3 | built; criteria being checked by someone other than the builder |
| `done` | 4 | criteria met |
| `dropped` | — | decided against. Off the ladder; the file stays, with a comment saying why. |

## Claude Code integration

BugDesk ships two skills that teach Claude the file formats, the lifecycles,
and how to read/write the stores directly — no server or API calls required,
just the markdown files:

- [`skills/bugs/SKILL.md`](skills/bugs/SKILL.md) — `/bugs`
- [`skills/backlog/SKILL.md`](skills/backlog/SKILL.md) — `/backlog`, including
  `/backlog refine`, whose playbook is
  [`REFINEMENT.md`](skills/backlog/REFINEMENT.md)

Install them into whichever project Claude will be working in (not necessarily
this repo — BugDesk is usually a sibling tool pointed at your project's own
stores via `BUGDESK_BUGS`):

```bash
# available in every project:
ln -s "$(pwd)/skills/bugs"    ~/.claude/skills/bugs
ln -s "$(pwd)/skills/backlog" ~/.claude/skills/backlog

# or scoped to one project:
mkdir -p /path/to/your-project/.claude/skills
ln -s "$(pwd)/skills/bugs"    /path/to/your-project/.claude/skills/bugs
ln -s "$(pwd)/skills/backlog" /path/to/your-project/.claude/skills/backlog
```

Then make sure `BUGDESK_AGENT` matches however you start the BugDesk server, so
the skills and the UI agree on who the agent is.

## FlexDesk

`ui/` depends on [FlexDesk](https://github.com/nor-os/FlexDesk) for its
kernel — event bus, settings store, state machine, the content registry, the
host port, taxonomy/entity-catalog plumbing.

The dependency is **pinned in `package.json` and vendored** into
`ui/vendor/flexdesk/`, which is committed. Both halves are deliberate: npm
decides *which* bytes, and `ui/vendor/` holds them because the UI has no build
step — `index.html` loads ES modules straight off disk through an import map,
and `node_modules/` is not on the served tree.

```bash
npm install                # fetch the pinned flexdesk
npm run sync:flexdesk      # copy its dist/ into ui/vendor/flexdesk/ + stamp VERSION
npm run check:flexdesk     # verify the vendored copy matches, change nothing
```

`check:flexdesk` exists because a stale vendor directory is otherwise
invisible: the app boots perfectly well on last release's code.

The tiling window manager itself (`ui/js/tiling/wm.js` and friends) stays
local: it carries bugdesk-specific behavior FlexDesk's generalized version
doesn't have (tab-opener tracking so Backspace returns to the tab that opened a
drill-down, store-specific breadcrumb segments), and its chrome is styled to
match the rest of BugDesk's UI rather than FlexDesk's own default look. See
`ui/js/tiling/kind_taxonomy.js` and `install.js` for exactly where the package
boundary sits.

## License

MIT — see [`LICENSE`](LICENSE). Third-party code vendored under `ui/vendor/`
(FlexDesk, CodeMirror, KaTeX, Monaco, Plotly, Material Symbols, …) keeps its
own license; see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
