---
name: tracker
description: "Use when the user asks to track, chase, or update work they have assigned to other people in a BugDesk tracker (a directory of PROJ-/EPIC-/STORY-/TASK-NNNN.md files with target dates) — or asks what is overdue, what is due this week, or what somebody owes them. Also triggers when the user pastes meeting minutes, an email, a chat log or standup notes and wants the tracker updated from them. Triggers on \"/tracker\", \"/tracker intake\", \"what's overdue\", \"what did I assign to X\", \"update the tracker from these minutes\", \"chase list\", or any mention of a BugDesk tracker, a PROJ- record, or a target date on a tracked item."
---

# /tracker

BugDesk in **tracker mode** is a follow-up tracker: a record of work the user
has handed to other people. It is the same markdown store the `/backlog` skill
drives — one file per item, no database, no required API call — read and
written directly.

**What makes it different is who is not in the room.** The people this work is
assigned to mostly have no access to this checkout and often do not know it
exists. Nobody else updates these files. Everything in them arrived because the
user, or you on the user's behalf, put it there after a meeting, an email or a
message. That single fact drives every rule below.

```
/tracker                              what is overdue, and what is due this week
/tracker list [filter]                "/tracker list on priya", "/tracker list project PROJ-1"
/tracker show <ref>                   one item in full
/tracker new <type> <title>           file a project / epic / story / task
/tracker assign <ref> <who> [by <date>]
/tracker due <ref> <date>             set or move a target date
/tracker chase                        who to chase, what to say, grouped by person
/tracker intake <source>              update the tracker from minutes / an email / a chat
/tracker status <ref> <status>        move along the lifecycle
/tracker comment <ref> <text>         append a comment as the agent
/tracker done <ref>                   close it out
```

`intake` is the operation this skill exists for — see
[INTAKE.md](INTAKE.md) before running one.

## Step 0 — find the store and the configured names

1. **Store directory.** In order: `BUGDESK_BACKLOG` if set; otherwise a
   `backlog/` directory *beside* the bug store; otherwise a `backlog/` at the
   project root; otherwise ask. Tracker mode does **not** use a different
   directory — the mode changes the UI and the vocabulary, not where the files
   live, so the same store opens either way.
2. **Names.** `GET /api/config` if a server is reachable — it returns
   `humanAuthor`, `agentAuthor`, the collaborator roster, and `mode`. Otherwise
   `BUGDESK_AGENT` (default `agent`) and `BUGDESK_HUMAN` (default `reviewer`).
   Since the human's name usually comes from a per-user profile rather than the
   environment, prefer `/api/config` and do not guess from env vars alone.
3. **Confirm the mode.** If `/api/config` reports `mode: "bugs"`, the user is
   not running a tracker. The files still work — `project`, `due` and
   `reporter` are legal in every mode — but the dashboard and the Project type
   will not be in their UI. Say so once rather than writing records they cannot
   see properly.

### The collaborator roster

`bugdesk.json`, beside the store and **committed**, is who can be assigned work:

```json
{ "collaborators": [ { "name": "priya", "agent": "priya_agent", "added": "2026-09-10" } ] }
```

In a tracker this list is mostly **people, not agents** — colleagues, vendors,
counterparts. Add anyone you assign to who is not on it: `POST
/api/project/collaborator` with `{"name": "..."}`, or append to the file. The
agent name is derived as `<name>_agent`; do not invent another convention.
Matching is case-insensitive, so "Priya" and "priya" are one entry.

## File format

```
backlog/
  PROJ-0001.md      project
  EPIC-0004.md      epic
  STORY-0007.md     story
  TASK-0031.md      task
```

**IDs are one sequence shared by all four prefixes.** The next id is
`max(existing id across every prefix) + 1`, never "next task number".

Note the prefix: a project is **`PROJ`**, not `PROJECT`. Never derive a
reference by upper-casing the type.

```markdown
---
id: 7
type: story
title: "Finance feed cut over to the new vendor"
status: in-progress
parent: 1
phase:
assignee: priya
reporter: norman
due: 2026-09-05
points: 5
subsystem: vendors
labels: [external]
links: []
created: 2026-09-01
updated: 2026-09-09
---

## Description

## Acceptance criteria

- [ ] Sign-off from the finance controller

## Comments

### 2026-09-09 · norman_agent

From the 2026-09-09 standup — Priya: "reconciliation passed, waiting on the
controller." No new date given.
```

The two fields that make this a tracker rather than a backlog:

- **due** — the target date, `YYYY-MM-DD`, or **empty**. Empty is a real state,
  not a missing value: it means nobody has committed to a date, which is
  precisely what the dashboard surfaces. **Never fill in a plausible date to
  make a record look complete.** The bridge rejects anything that is not
  `YYYY-MM-DD` rather than storing it, because a date that cannot be parsed can
  never be overdue — it would sit in the one blind spot the tool must not have.
- **reporter** — who is following it up, as opposed to `assignee`, who is doing
  it. Set it to the human name from step 0 for anything you file on the user's
  behalf. This is what makes "what did I assign" answerable at all; records
  written before it existed carry none, and that is fine.

Everything else behaves exactly as in `/backlog`: `type` must agree with the
filename prefix (**the filename wins**), `parent` is a bare number, `created`
is set once, `updated` is bumped on *any* edit, and comment headers are
`### YYYY-MM-DD · author`.

## Hierarchy

```
PROJ-0001  Q4 vendor migration          due: 2026-12-15
 ├ STORY-0002  Finance feed cutover     parent: 1   assignee: priya  due: 2026-09-05
 │  └ TASK-0003  DPA to legal           parent: 2
 ├ STORY-0004  Operations feed cutover  parent: 1   assignee: sam    due: 2026-10-01
 └ TASK-0005   Confirm analytics owner  parent: 1   assignee:        due:
```

- A **project** is the thing you are tracking as a whole — a migration, a
  launch, an audit. It sits at the top and has no parent.
- **A story or a task may hang directly off a project.** Do not manufacture an
  epic to sit in between. Most tracked work is one or two levels deep, and an
  epic that exists only to hold one task is a record nobody reads.
- An **epic** is worth creating when a project has a chunk of work with several
  stories under it and its own owner.

The bridge enforces only that a parent **exists** and that the graph stays
**acyclic**. It does not enforce type pairs, so an arrangement you find in a
store is legitimate even if it skips a level.

## Lifecycle

```
PROJECT draft ──────────────▶ in-progress ──────────────▶ done
EPIC    draft ──▶ refined ──▶ in-progress ──────────────▶ done
STORY   draft ──▶ refined ──▶ in-progress ──▶ review ──▶ done
TASK    draft ──────────────▶ in-progress ──────────────▶ done

(any state) ──▶ dropped
```

**A project is never `refined` and never `review`.** It is a container: it has
no acceptance criteria of its own to refine, and its stories are what get
reviewed, one at a time. The bridge rejects both with the ladder in the error.

In a tracker, `refined` matters much less than it does in a backlog — you are
not grooming work for yourself, you are recording what somebody agreed to do.
`draft` means "raised, not yet agreed"; `in-progress` means "they are on it".

## Target dates

The date is a **commitment somebody made**, not your estimate of when the work
will land. That distinction is the whole value of the field:

- Set `due` when a person names a date. Record who and when in a comment.
- If a date slips, **move it and say why in a comment** — never overwrite it
  silently. The comment thread is the only record of how many times something
  has moved, and that pattern is usually the real finding.
- If somebody misses a date and gives no new one, **leave the old date in
  place**. It stays overdue, which is accurate. Replacing it with a guess makes
  the tracker report good news it has no basis for.
- If nobody has committed to a date, leave `due` empty. The dashboard has a
  section for exactly this.

`done` and `dropped` items are off the schedule entirely — a date that passed
after the work was delivered is not a problem.

## Operations

**What is overdue / due** — read the frontmatter of every `PROJ-*.md`,
`EPIC-*.md`, `STORY-*.md`, `TASK-*.md`. An item is overdue when it has a `due`
in the past *and* its status is not `done` or `dropped`. Report worst-first,
**with the assignee's name in every line** — "3 items overdue" is a number
someone nods at; "Priya — finance sign-off, 9 days late" is one they act on.

**Chase** — group open work by assignee and, for each person, give the user
something they could actually send: what is late, by how long, and what was
last said about it (the most recent comment). Do not draft the message unless
asked; give them the facts it would be built from.

**New** — scan every prefix for the max `id`, use `max + 1`. Write the file per
the format above with `status: draft`, `created`/`updated` today, `reporter`
set to the human, and `parent` if you know it. Set `due` **only** if a date was
actually given.

**Assign** — set `assignee`, add the person to `bugdesk.json` if they are new,
and bump `updated`. If the assignment came with a date, set `due` too.

**Intake** — see [INTAKE.md](INTAKE.md).

**Comment / status / done** — as in `/backlog`: append per the header rule,
edit the frontmatter line in place, bump `updated`. Tick acceptance criteria
only for outcomes somebody has actually reported.

## What NOT to do

- **Don't invent a target date.** Not to fill a gap, not to make a record look
  refined, not because one "seems reasonable". An empty `due` is information.
- **Don't move a date without a comment saying why.** The slip history is the
  finding.
- **Don't mark something in-progress or done because it sounds like it should
  be.** In a tracker you are recording what other people said, and they are not
  here to correct you. If the source does not say it, it did not happen — file
  a comment recording what you actually heard instead.
- **Don't attribute a status to a person who did not give one.** "No update
  from Sam this week" is a real and useful entry.
- Don't create an epic just to have somewhere to put one task.
- Don't renumber or reuse an `id`; the sequence is shared across all four
  prefixes.
- Don't put bugs in this store — a defect in the user's own code belongs in the
  bug store, with `/bugs`.
- Don't try to put a project in `refined` or `review`. The bridge rejects both.
- Don't restart or require the BugDesk server for any of this. It is optional
  tooling for the human, not a dependency of the file format.
