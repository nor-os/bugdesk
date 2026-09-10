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
/backlog start <ref>              CLAIM it: in-progress + assignee you, committed and pushed
/backlog done <ref>               hand it back: review or done + the human, committed and pushed
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
  PROJ-0001.md      only in tracker mode — see below
  EPIC-0004.md
  STORY-0007.md
  TASK-0031.md
```

**IDs are one sequence shared by all four prefixes.** The next id is
`max(existing id across every prefix) + 1`, never "next story number". That is
what makes `parent: 7` unambiguous without also naming a type.

**`PROJ` is a fourth level above epics.** BugDesk offers it only in *tracker*
mode — a follow-up tracker for work handed to other people, driven by the
sibling [`/tracker`](../tracker/SKILL.md) skill — but it is a legal record in
any store, so you may meet one here. Read it, respect it as an ancestor, and
leave the tracker's own conventions (target dates, `reporter`) to that skill.
Note the prefix is `PROJ`, not `PROJECT`: never derive a reference by
upper-casing the type.

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

- **type**: `epic | story | task` (plus `project`, in a tracker store). Must
  agree with the filename prefix — if they ever disagree, **the filename wins**
  (that is what the server does), so fix the frontmatter, never the other way
  round.
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

The status **vocabulary** is shared by every type. The **ladder** each type
walks is not:

```
PROJECT draft ──────────────▶ in-progress ──────────────▶ done
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
are, one at a time. A status nobody can act on is worse than no status. **A
project is neither `refined` nor `review`**, for both reasons at once: it is a
container with no acceptance criteria of its own, and what gets reviewed is the
work inside it.

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

## Working on an item — the sequence

**This is required, and it is required in this order.** Every step, every item.

```
0.  REFINE FIRST   if it is not refined yet — and it is not optional
      COMMIT AND PUSH
1.  CLAIM          status: in-progress   assignee: <agent>
2.  COMMIT AND PUSH            ← the record only, before any work exists
3.  DO THE WORK                commit as you normally would
4.  HAND BACK      status: per the table below   assignee: <human>   + a comment
5.  COMMIT AND PUSH
```

**Why the claim is pushed before you start.** The backlog is committed and
shared — that is the whole point of it. Until your claim is *pushed*, nothing
anywhere says the item is taken: it sits in `refined`, which explicitly means
*anyone can pick this up*, and somebody does. The claim commit is the
announcement, and pushing it is what makes it true for anybody but you.

It also means **a rejected push is how you find out you lost the race.** If a
push is rejected, `git pull --rebase` and re-read the record. If it now shows
somebody else as `assignee` with `status: in-progress`, they got there first —
**stop, do not work on it, and say so.**

### 0. Refinement is a gate, not a nicety

**An item that is not refined does not get worked on.** Refine it first, as its
own step, with its own commit — and only then claim it.

| the item | the gate |
|---|---|
| **epic** or **story** in `draft` | refine it: [REFINEMENT.md](REFINEMENT.md), then `status: refined` |
| **task** in `draft` | a task never passes through `refined` — it inherits its story's acceptance criteria, so **the gate is on its parent story.** If the parent is not refined, refine the parent. If the task has no parent at all, that is the refinement problem: resolve it before working. |
| **project** | not worked on directly. Work on the things inside it. |

The bridge will *let* you go straight from `draft` to `in-progress` — the ladder
check tests membership, not adjacency — so nothing stops you but this rule.
Follow it anyway. Acceptance criteria are the definition of done, and work
started before anybody wrote them is work whose completion is a matter of
opinion.

**Refinement gets its own commit, pushed on its own**, ahead of the claim:

```
STORY-0007: refined

3 acceptance criteria, 5 points, parented to EPIC-0001
```

Separate because it is a different kind of decision from doing the work, and it
is the one the human is most likely to want to change. **Say what you wrote** —
if they are there, that is their moment to correct the criteria, before you have
built anything against them. An agent that writes its own acceptance criteria
and then satisfies them has marked its own homework; pushing them first, on
their own, is what keeps that honest.

If you cannot refine it — the outcome is unclear, nobody has said what done
means — **stop and ask.** Do not refine it into something plausible so the
sequence can continue.

### 1–2. Claim, commit, push

Set `status: in-progress`, `assignee: <agent>`, `updated:` today. Nothing else.
Commit the record on its own and push it:

```
STORY-0007: taking this on

status: refined -> in-progress, assignee -> <agent>
```

Already `in-progress` and already yours? You have claimed it — skip to the work
rather than writing a no-op commit. Assigned to **somebody else** and not
finished? Do not take it; ask.

If the repo has no remote, commit and skip the push — say so once, so the user
knows the claim is local and the race window is still open.

### 3–5. Work, hand back, push

Read the acceptance criteria before you write any code: they are the definition
of done and they are frequently more specific than the description. As outcomes
start to hold, tick them (`- [ ]` → `- [x]`) — in place, one criterion per line,
leaving the surrounding text alone, because the human ticks the very same boxes
through the UI's checklist.

Where it goes when you are finished:

| type | status | assignee | why |
|---|---|---|---|
| **story** | `review` | the human | somebody other than the builder checks the criteria |
| **task** | `done` | the human | a task has no review of its own; it returns to the person who will review the story it belongs to |
| **epic** | — | — | an epic is not finished by hand. It reaches `done` when its last story does |

**Finishing the last task under a story? Move the story on too.** A story whose
tasks are all `done` but which is still sitting in `in-progress` is a story
nobody is going to review, and the tree stops meaning anything.

**Any criterion still unticked means the item is not done.** Either finish it,
or say in a comment why the criterion changed and get it amended — do not hand
back an item whose definition of done you quietly moved.

Always **append a comment** with the handback: what you built, what you ticked,
and anything you decided along the way. The status routes it; the comment is
what lets the reviewer verify it without reading the diff.

### When not to follow it

Only when the user says so — "don't commit this yet", "just draft it". Follow
that, and say plainly that the item is unclaimed so they know the state it is
in. The *size* of a change is never a reason to skip the claim.

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

**Start** — the claim step of the sequence above: refine first if it is not
refined, then `status: in-progress`, `assignee: <you>`, committed and **pushed
before you begin**.

**Done** — the handback step of the sequence above: tick what now holds, move to
`review` (a story) or `done` (a task), reassign to the human, comment, commit
and push.

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
- **Don't start work before the claim is pushed**, and don't batch the claim
  into the commit that carries the work. A claim that arrives with the work
  announced nothing to anyone.
- **Don't work around the refinement gate** by going `draft` → `in-progress`.
  The bridge allows it; this skill does not.
- **Don't refine an item into something plausible** so you can get on with it.
  If nobody has said what done means, ask.
- Don't mark something `refined` that doesn't pass the checks in
  REFINEMENT.md. The UI shows the user exactly which checks failed, so a status
  you can't justify is visible immediately.
- Don't try to put an epic in `review` or a task in `refined`. The bridge
  rejects both, and the attempt means the item is the wrong type for the work
  it describes.
- Don't tick an acceptance criterion you haven't verified.
- Don't restart or require the BugDesk server for any of this — it's optional
  tooling for the human, not a dependency of the file format.
