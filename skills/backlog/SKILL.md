---
name: backlog
description: "Use when the user asks to plan, break down, refine, pick up, or close out feature work tracked in a BugDesk backlog (a directory of EPIC-/STORY-/TASK-NNNN.md files) — or asks what's next, what's in a phase, or what's on their plate. Triggers on \"/backlog\", \"/backlog refine\", \"plan the next phase\", \"break this epic into stories\", \"what's ready to work on\", \"groom the backlog\", or any mention of a BugDesk backlog/ directory, an epic, a work package, or a story."
---

# /backlog

BugDesk tracks feature work as plain markdown files, one per item, in a
directory (the "backlog store") — the same idea as the bug store the `/bugs`
skill drives, over a second directory and a different lifecycle. There is no
database and no required API round-trip: you read and write these files
directly. A human plans and triages the same files through the BugDesk UI
(`./run.sh` in the `bugdesk` checkout, Backlog tab); you never need that server
running, though it's fine if it is — it reads the files fresh on every request.

**Bugs are what broke. The backlog is what you meant to build.** Keep them in
their own stores: a bug has a severity and a reproduction, an item has a size
and an acceptance criterion, and cramming both into one record makes every
field optional for half the rows.

## Usage

```
/backlog                          what's ready to work on, and what's in flight
/backlog list [filter]            list items — "/backlog list draft", "/backlog list phase foundation"
/backlog show <ref>               print one item: frontmatter + description + criteria + comments
/backlog new <type> <title>       file an epic / story / task
/backlog plan <phase>             lay out a phase: its epics, and what each still needs
/backlog breakdown <epic>         split a work package into stories (and stories into tasks)
/backlog refine [ref|phase]       run refinement (epics + stories) — see REFINEMENT.md
/backlog start <ref>              take an item: status in-progress, assignee you
/backlog done <ref>               finish an item: check criteria, status review or done
/backlog comment <ref> <text>     append a comment as the agent
/backlog status <ref> <status>    move along the lifecycle
/backlog assign <ref> <who>       change assignee
```

These are natural-language patterns, not a rigid CLI — "what should I work on
next", "split the auth epic into stories", "this story is done", "groom the
foundation phase" all map onto the operations below. Use judgment about which
operation(s) a request implies.

## Step 0 — find the store and the configured names

1. **Backlog directory.** In order: the `BUGDESK_BACKLOG` environment variable
   if set; otherwise a `backlog/` directory *beside* the bug store (so if bugs
   are at `<project>/bugs`, the backlog is at `<project>/backlog`); otherwise a
   `backlog/` at the root of the current project; otherwise ask. This is the
   same resolution BugDesk's own server uses — see `ResolveBacklogDir` in
   `bugdesk/server/Program.cs` if you have that repo checked out.
2. **Names.** Identical to `/bugs`: `BUGDESK_AGENT` (default `agent`) is the
   exact string you write as comment author and as `assignee` when an item is
   on you; `BUGDESK_HUMAN` (default `reviewer`) is the person. If a BugDesk
   server is reachable, `GET /api/config` returns the live pair — prefer it.
   Since BugDesk 0.2 the human's name usually comes from a **per-user profile**
   (`.bugdesk/user-<name>.json` beside the store, git-ignored) rather than an
   environment variable, so `/api/config` is the reliable source and guessing
   from the environment alone can be wrong.

### The collaborator roster

`.bugdesk/project.json`, **committed**, lists everyone who can be
assigned work here:

```json
{
  "collaborators": [
    { "name": "norman", "agent": "norman_agent", "added": "2026-09-10" },
    { "name": "alice",  "agent": "alice_agent",  "added": "2026-09-12" }
  ]
}
```

**Where it lives.** `.bugdesk/project.json` — the one file in that directory
that is committed; its `.gitignore` ignores everything else there (names,
filters, layouts, which are per-person). A repo set up before this moved has it
at the project root as `bugdesk.json` instead, and that still wins when it
exists — check both. `GET /api/project` reports the resolved `path`.

Read it before you assign anything: `assignee` must be one of these names or
one of their agents, or the UI's pickers and "On me" filters will not recognise
it. `GET /api/project` returns the same list plus a flat `assignees` array when
a server is reachable.

**Keep it current.** If you are working with someone whose name is not on the
list — a name from `git log`, or a person the user mentions — add them:
`POST /api/project/collaborator` with `{"name": "..."}`, or append to the file
directly. The agent name is derived as `<name>_agent` unless one is given;
don't invent a different convention. A person is matched case-insensitively, so
"Alice" and "alice" are one entry, not two.

Don't hardcode `"agent"` / `"reviewer"` / a person's name in anything you
write — always use whatever you resolved here.

## File format

One file per item. The prefix carries the type; the number is the id:

```
backlog/
  EPIC-0001.md
  STORY-0007.md
  TASK-0031.md
```

**IDs are one sequence shared by all three prefixes.** The next id is
`max(existing id across every prefix) + 1`, never "next story number". That is
what makes `parent: 7` unambiguous without also naming a type.

```markdown
---
id: 7
type: story
title: "Log in with the company SSO provider"
status: refined
parent: 1
phase:
assignee: agent
points: 5
subsystem: auth
labels: [security]
links: [blocked-by STORY-9, relates BUG-42]
created: 2026-09-02
updated: 2026-09-10
---

## Description

Why this is worth building, and for whom. Not an implementation plan — the
plan belongs in the tasks underneath it.

## Acceptance criteria

- [ ] An unauthenticated user hitting /app is redirected to the IdP
- [ ] A successful callback creates a session and lands on the last page
- [x] Revoking the grant at the IdP logs the user out within 60s

## Comments

### 2026-09-10 · agent

Refined: 3 criteria, 5 points, parented to EPIC-0001.
```

Field notes:

- **type**: `epic | story | task`. Must agree with the filename prefix — if
  they ever disagree, **the filename wins** (that is what the server does), so
  fix the frontmatter, never the other way round.
- **status**: `draft | refined | in-progress | review | done`, plus the
  off-ladder terminal `dropped`. **Which of these an item may hold depends on
  its type** — see Lifecycle.
- **parent**: another item's numeric id, or empty. Stories hang off epics,
  tasks off stories (or directly off an epic when a task needs no story around
  it). Epics have no parent. Both `parent: 7` and `parent: STORY-7` parse, but
  **write the bare number** — that is the canonical form.
- **phase**: a milestone label, authored **on epics only**. Stories and tasks
  inherit it through their ancestors; leave their `phase:` empty rather than
  copying the string down, or the two will drift and the copy will win in
  exactly the report you care about. (See Phases below.)
- **points**: a relative estimate, free text (`1`, `3`, `M`, whatever the
  project uses). Empty means *not estimated* — a real state, distinct from `0`,
  and one of the refinement checks.
- **labels**, **links**: bracketed, comma-separated. A link is `"<verb>
  <target>"` — `blocks 12`, `blocked-by STORY-9`, `relates BUG-42`. Store only
  the direction you're asserting; the inverse is derived at display time, never
  written into the other file.
- **created**: set once, on file, never touched again.
- **updated**: bump to today (`YYYY-MM-DD`) on *any* edit — frontmatter,
  criteria, or a new comment.

### Sections

`## Description` and `## Comments` behave exactly as in `/bugs`.
`## Acceptance criteria` is new and is the point of the whole format: a
markdown task list, **one checkable outcome per line**, written from the
outside (what someone can observe) rather than the inside (what you'll change).
`- [x]` marks a met criterion; the UI counts them and shows `2/3`.

An item that hasn't been refined yet carries the placeholder
`_(not refined yet)_` there. Replace it wholesale — don't append below it.

### Comment headers

`### <YYYY-MM-DD> · <author>`, and the parser takes everything after `· ` up to
the first `(` as the author — same rule, same trap, as `/bugs`. New comments
append to the bottom of `## Comments`.

## Hierarchy

```
EPIC-0001  Auth rewrite            phase: foundation
 ├ STORY-0007  Log in with SSO     parent: 1
 │  ├ TASK-0031  wire OIDC client  parent: 7
 │  └ TASK-0032  session cookie    parent: 7
 └ STORY-0008  Revoke propagation  parent: 1
```

- An **epic** is a *work package*: a coherent chunk of value with a beginning
  and an end. If you can't say what shipping it changes for someone, it's a
  bucket, not an epic.
- A **story** is one outcome, small enough to have acceptance criteria that
  fit on a screen.
- A **task** is a step. Tasks may have no acceptance criteria of their own;
  they inherit their story's.

## Phases

A phase is a **milestone label on an epic** (`phase: foundation`), not a record
type. Stories and tasks inherit it from whichever ancestor sets it. So:

- To put work in a phase, set `phase:` on its **epic**.
- To ask "what's left in phase X", walk every item whose *effective* phase is
  X — its own, or the nearest ancestor's.
- To move a work package between phases, edit **one** line in one file.

`/backlog plan <phase>` is the read side of this: list the phase's epics, their
stories, what's done, and — most usefully — what is still `draft`, since that
is the work nobody can start.

## Lifecycle

The status **vocabulary** is shared by all three types. The **ladder** each type
walks is not:

```
EPIC    draft ──▶ refined ──▶ in-progress ──────────────▶ done
STORY   draft ──▶ refined ──▶ in-progress ──▶ review ──▶ done
TASK    draft ──────────────▶ in-progress ──────────────▶ done

(any state) ──▶ dropped        done ──▶ reopen to the previous state
```

| status | meaning |
|---|---|
| `draft` | captured, not yet worth starting — no criteria, maybe no parent |
| `refined` | ready: criteria, estimate, a place in the tree. **Anyone can pick it up.** |
| `in-progress` | someone is on it (`assignee` says who) |
| `review` | built; criteria being checked by someone other than the builder |
| `done` | criteria met |
| `dropped` | decided against. Off every ladder; keep the file and say why in a comment. |

**An epic is never `review`.** An epic is not reviewed as a unit — its stories
are, one at a time. A status nobody can act on is worse than no status.

**A task is never `refined`.** A task inherits its parent story's acceptance
criteria, so there is nothing about it to refine: no criteria of its own, no
independent estimate worth arguing about. A task goes from `draft` straight to
`in-progress`. This also means `/backlog refine` **skips tasks** — if you find
yourself refining one, what you actually have is a story.

The server enforces this: `POST /api/backlog/{id}` with a status the type's
ladder does not contain is rejected with the ladder in the error. And retyping
an item onto a shorter ladder CLAMPS its status **downward** — a story in
`review` demoted to a task becomes an `in-progress` task, never a `done` one,
because nobody decided it was done.

`refined` is the only transition with a **precondition** — see REFINEMENT.md.
Every other move is a judgment call. Never delete an item to cancel it; drop
it, with a comment giving the reason. A deleted file loses the decision.

## Operations

**List / what's next** — read the frontmatter of every `EPIC-*.md`,
`STORY-*.md`, `TASK-*.md`. Default answer to a bare `/backlog`: items that are
`refined` (ready to start) and items that are `in-progress` (already moving,
with who's on them). Sort epics before their stories before their tasks.
Report `<REF> <title> — <status>, <points>, <assignee>`.

**Show** — one file, rendered in order: frontmatter, description, acceptance
criteria (with the met/total count), comments.

**New** — scan every prefix for the current max `id`, use `max + 1`. Write the
file per the format above with `status: draft`, `created`/`updated` today, and
a `parent` if you know it. A brand-new item is `draft` even if you happen to
write good criteria for it immediately — promote it with the refine step, so
the refinement checks actually run.

**Breakdown** — the core epic operation. Read the epic's description, propose
stories that each deliver something observable, and for each one you're told to
create: file a story with `parent: <epic id>`, then refine it. Do **not**
create tasks under a story until the story is refined — tasks written against
an unrefined story are a plan for work nobody has agreed on yet.

**Refine** — see [REFINEMENT.md](REFINEMENT.md). This is the operation the
skill exists for. Epics and stories only; tasks have no `refined` state.

**Start** — set `status: in-progress` and `assignee: <you>`. Read the
acceptance criteria before you write any code; they are the definition of done
and they are frequently more specific than the description.

**Done** — go through the acceptance criteria and tick the ones that now hold
(`- [ ]` → `- [x]`). Edit the line in place; the human ticks the very same
boxes through the UI's checklist, so keep one criterion per line and leave the
surrounding text alone. If any remain unticked, the item is **not** done —
either finish them, or say in a comment why the criterion changed and get it
amended.
Then set `status: review` (someone else checks) or `done` when you're closing
out work you were explicitly asked to close.

**Comment / status / assign** — as in `/bugs`: append per the header rule, edit
the frontmatter line in place, and bump `updated`.

## Linking a bug to backlog work

A bug that turns out to be missing feature work, or a story that is being held
up by a defect, links across the two stores with a prefixed target:

```yaml
# in BUG-0042.md
links: [relates STORY-7]

# in STORY-0007.md
links: [blocked-by BUG-42]
```

Bare numeric targets mean the *same* store; prefixed ones cross over. Only ever
write the direction you're asserting.

## What NOT to do

- Don't put bugs in the backlog store or features in the bug store. If a
  request is "make it stop crashing", it's a bug; if it's "make it able to",
  it's backlog.
- Don't copy an epic's `phase` down onto its stories and tasks. It's inherited.
- Don't renumber or reuse an `id`, even for an item you're dropping — and
  remember the sequence is shared across all three prefixes.
- Don't create tasks under an unrefined story, or stories under an epic you
  haven't read.
- Don't mark something `refined` that doesn't pass the checks in
  REFINEMENT.md. The UI shows the user exactly which checks failed, so a status
  you can't justify is visible immediately.
- Don't try to put an epic in `review` or a task in `refined`. The bridge
  rejects both, and the attempt means the item is the wrong type for the work
  it describes.
- Don't tick an acceptance criterion you haven't verified.
- Don't restart or require the BugDesk server for any of this — it's optional
  tooling for the human, not a dependency of the file format.
