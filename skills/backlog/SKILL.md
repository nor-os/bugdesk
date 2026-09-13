---
name: backlog
description: "Use when the user asks to plan, break down, refine, pick up, or close out feature work tracked in a BugDesk backlog (a directory of EPIC-/STORY-/TASK-NNNN.md files) — or asks what's next, what's in a phase, or what's on their plate. Triggers on \"/backlog\", \"/backlog refine\", \"plan the next phase\", \"break this epic into stories\", \"what's ready to work on\", \"groom the backlog\", or any mention of a BugDesk backlog/ directory, an epic, a work package, or a story."
---

# /backlog

BugDesk tracks feature work as plain markdown files, one per item, in a
directory (the "backlog store") — the same idea as the bug store the `/bugs`
skill drives, over a second directory and a different lifecycle. **The files are
the whole interface.** You read and write them directly: no database, no server
to start, and no HTTP call anywhere in this skill.

A human plans and triages the same files through the BugDesk UI (`./run.sh` in
the `bugdesk` checkout, Backlog tab). Whether that is running changes nothing —
it reads the files fresh on every request, so filesystem edits and the UI agree
instantly.

**Do not call the BugDesk HTTP API.** Not as a first choice, not as a fallback.
Everything it would tell you — the names, the roster, the records — it reads
from the files you already have, and a server that happens to be listening on
this machine may be serving a *different* project: taking an answer from it is
how you end up assigning work under somebody else's name. `curl` failing because
nothing is listening is the better half of that failure; being answered by the
wrong store is the half that does damage.

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
/backlog done <ref>               hand it back: review or done + the REPORTER, committed and pushed
/backlog comment <ref> <text>     append a comment signed with YOUR agent name
/backlog status <ref> <status>    move along the lifecycle
/backlog assign <ref> <who>       change assignee
/backlog duplicate <ref> <target> drop it as a duplicate of another record
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
2. **The two names.** Identical to `/bugs`, and resolved the same way the
   server does — **from the same files**. The HUMAN is the person this checkout
   belongs to — the default `reporter` on anything you file here, and the
   fallback owner of a record whose `reporter` predates the field; the AGENT is
   the exact string you sign comments with and write as `assignee` when an item
   is on you. They have to match what the UI resolves, or its "On agent" /
   "needs my reply" filters won't recognise your comments as yours.

   1. **Which profile.** `BUGDESK_USER` if set, slugified (lower-cased; each run
      of non-alphanumeric characters becomes one `-`; trimmed of `-`). Otherwise
      the `user` field of `<config>/active.json`.

      No `active.json` and exactly one `user-*.json`? That one. This is the
      normal state of a `BUGDESK_HUMAN=... ./run.sh` deployment, not a broken
      one: seeding writes the profile but deliberately leaves `active.json`
      alone, so one person's scripted run cannot repoint the checkout's default
      for everybody else. Several profiles and no `active.json`: fall through to
      the environment, and if that is empty too, **ask**.
   2. **The names.** `<config>/user-<slug>.json` — `name` is the human,
      `agentName` is the agent.
   3. **Fallbacks, in order.** `BUGDESK_HUMAN` / `BUGDESK_AGENT`, then
      `reviewer` / `agent`.

   `<config>` is `BUGDESK_CONFIG` if set, otherwise `.bugdesk/` beside the
   stores — `<bug store>/../.bugdesk`, which is the same directory whether you
   came in through the bug store or the backlog.

   **The profile beats the environment**, which is why it is read first.
   `BUGDESK_HUMAN`/`BUGDESK_AGENT` only seed a name when no profile exists yet;
   once the human has set one — through the first-run screen or "change your
   name" — the file is the answer and the variables are ignored. A
   `BUGDESK_HUMAN` you can see in your environment may name somebody the user
   has since changed away from.

   An item goes back to its **`reporter`**, which is not necessarily the human
   you resolve here: on a shared store, somebody else filed half of them.

   Never write into `.bugdesk/` yourself — the profiles are the human's, and
   they are git-ignored precisely so they stay that way. (`project.json` is the
   exception; see below.)

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

**Where it lives.** In order, exactly as the server resolves it: the
`BUGDESK_PROJECT` environment variable if set; otherwise `bugdesk.json` beside
the store (`<store>/../bugdesk.json`) if that file exists — repos set up before
this moved have it committed at the project root, and it still wins; otherwise
`<config>/project.json`, which is the one file in `.bugdesk/` that is committed
(its `.gitignore` ignores everything else there — names, filters, layouts, which
are per-person).

Read it before you assign anything: `assignee` must be one of these names or one
of their agents, or the UI's pickers and "On me" filters will not recognise it.
A missing or malformed file is an empty roster, not an error — same as the
server treats it.

**Keep it current.** If you are working with someone whose name is not on the
list — a name from `git log`, or a person the user mentions — **append them to
the file**. The agent name is derived as `<name>_agent` unless one is given;
don't invent a different convention. A person is matched case-insensitively, so
"Alice" and "alice" are one entry, not two. A running UI picks the new entry up
on its next reload; nothing needs restarting, and nothing needs an API call.

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
assignee: norman_agent
reporter: norman
points: 5
subsystem: auth
labels: [security]
links: [blocked-by STORY-9, relates-to BUG-0042]
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

## History

- 2026-09-10 · norman_agent · status: draft -> refined
- 2026-09-12 · norman_agent · assignee: norman -> norman_agent

## Comments

### 2026-09-10 · norman_agent

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
- **reporter**: who asked for this — the person the item goes back to when you
  hand it over, as distinct from `assignee`, which says whose court it is in
  right now. Written once, when the file is created, and never again; an item
  with no `reporter:` line predates the field, so read it as the configured
  human and leave the file alone rather than backfilling a guess. The canonical
  definition is in [`/tracker`](../tracker/SKILL.md) — the field means the same
  thing in all three stores.
- **due**: a target date, `YYYY-MM-DD`, or empty. **Inherited** from the nearest
  dated ancestor when empty, exactly as `phase` is — a task under a story due on
  the 14th is due on the 14th. Set one on the item to override it; clear it to go
  back to inheriting. **Do not copy a parent's date down** onto its children: the
  copy stops tracking the moment the parent moves, and it wins in exactly the
  report you care about. A sub-item dated LATER than its parent is allowed and is
  flagged in the UI — it means the parent's date is already wrong and nobody has
  moved it yet, which is worth a comment.
- **points**: a relative estimate, free text (`1`, `3`, `M`, whatever the
  project uses). Empty means *not estimated* — a real state, distinct from `0`,
  and one of the refinement checks.
- **labels**, **links**: bracketed, comma-separated. A link is
  `"<verb> <target>"`, and the verbs are `duplicates`, `blocks`, `blocked-by`,
  `requires`, `caused-by`, `relates-to` and `implements` — those seven, because
  the UI derives the inverse of each one ("is blocked by", "is implemented by")
  and a verb it doesn't know is dropped on read, silently. (`related` is read as
  an old spelling of `relates-to`; don't write new ones.) Store only the
  direction you're asserting; the inverse is derived at display time, never
  written into the other file. A **bare number means this store** —
  `blocked-by 9` in a backlog item is item 9. A **prefixed target crosses over**
  and is zero-padded to four: `blocks BUG-0042`, `relates-to EPIC-0001`.
  `STORY-9` still reads; write the padded form, and nothing will rewrite one you
  left.
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
the first `(` as the author — same rule, same trap, and the same identity rule
as [`/bugs`](../bugs/SKILL.md), including the rule about signing with your own
agent name rather than the bare word `agent`. New comments append to the bottom
of `## Comments`.

History entries: same grammar, same placement — see [`/bugs`](../bugs/SKILL.md).

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
- A **task** is a step. It may carry acceptance criteria of its own, and it
  **does not inherit its story's** — write them when what "done" means for the
  step is worth stating, and leave them off when it is obvious.

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

**A task is never `refined`.** It goes from `draft` straight to `in-progress`,
so `/backlog refine` **skips tasks** — there is no transition to run them
through.

**But a task does NOT inherit its parent's acceptance criteria.** It has its own,
or none. Nothing anywhere copies or resolves a parent's criteria onto a task, so
treating a task as covered by them means treating it as covered by a list that
describes something else. Write criteria on a task when what "done" means for it
is worth writing down, and leave them off when it is obvious — an unticked box
on a task is as real as one on a story.

**You are writing the file, so this is yours to enforce.** BugDesk enforces it
too — the UI rejects a status the type's ladder does not contain, and names the
ladder in the error — but nothing stands between your editor and the file, so a
`refined` task is one you wrote. Retyping an item onto a shorter ladder CLAMPS
its status **downward**: a story in `review` demoted to a task becomes an
`in-progress` task, never a `done` one, because nobody decided it was done.

`refined` is the only transition with a **precondition** — see REFINEMENT.md.
Every other move is a judgment call. Never delete an item to cancel it; drop
it, with a comment giving the reason. A deleted file loses the decision.

## Working on an item — the sequence

**This is required, and it is required in this order.** Every step, every item.

```
0.  REFINE FIRST    if it is not refined yet — and it is not optional
      COMMIT AND PUSH
1.  CLAIM           status: in-progress   assignee: <your agent>   + history
2.  COMMIT AND PUSH         ← the record only, before any work exists
3.  DO THE WORK             commit and push it the way the repo normally does
4.  COMMENT                 what you built and what you ticked
5.  HAND BACK       status + assignee: per the table below      + history
6.  COMMIT AND PUSH         ← 4 and 5 are one edit and one commit
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
| **task** in `draft` | a task never passes through `refined`, so there is nothing to gate on the task itself. **The gate is on its parent story:** tasks written against an unrefined story are a plan for work nobody has agreed on yet, so refine the parent first. If the task has no parent at all, that is the problem to resolve before working. (This is a rule about the PLAN, not about inheritance — a task's acceptance criteria are its own.) |
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

Set `status: in-progress`, `assignee: <your agent>`, `updated:` today, and
append the two `## History` lines that record those two moves. Nothing else —
`reporter:` is not yours to touch. Commit the record on its own and push it:

```
STORY-0007: taking this on

status: refined -> in-progress, assignee -> <agent>
```

Already `in-progress` and already yours? You have claimed it — skip to the work
rather than writing a no-op commit. Assigned to **somebody else** and not
finished? Do not take it; ask.

If the repo has no remote, commit and skip the push — say so once, so the user
knows the claim is local and the race window is still open.

### 3–6. Work, comment, hand back, push

Read the acceptance criteria before you write any code: they are the definition
of done and they are frequently more specific than the description. As outcomes
start to hold, tick them (`- [ ]` → `- [x]`) — in place, one criterion per line,
leaving the surrounding text alone, because the human ticks the very same boxes
through the UI's checklist.

Where it goes when you are finished:

| type | status | assignee | why |
|---|---|---|---|
| **story** | `review` | the item's `reporter` | they asked for it; they decide it's done |
| **task** | `done` | the item's `reporter` | ditto — falling back to the configured human when the field is absent |
| **epic** | — | — | an epic is not finished by hand |

**Finishing the last task under a story? Move the story on too.** A story whose
tasks are all `done` but which is still sitting in `in-progress` is a story
nobody is going to review, and the tree stops meaning anything.

**Any criterion still unticked means the item is not done.** Either finish it,
or say in a comment why the criterion changed and get it amended — do not hand
back an item whose definition of done you quietly moved.

Always **append a comment** with the handback: what you built, what you ticked,
and anything you decided along the way. The status routes it; the comment is
what lets the reviewer verify it without reading the diff.

**Read the `reporter` out of the file** rather than assuming it — that is where
the item goes back to, and only an item with no `reporter:` line at all falls
back to the human you resolved in step 0, which is worth saying in the comment
so the next reader can tell a guess from a fact. Append a `## History` line for
the status move and another for the assignee move.

The comment, the ticks, the status, the assignee and the history lines are one
edit and one commit:

```
STORY-0007: handing back to norman for review

status: in-progress -> review, assignee -> norman
```

Every record edit is committed and pushed as you make it, and the human's UI
edits are committed first. The rule and its reasoning are in
[`/bugs`](../bugs/SKILL.md) — same store discipline, same commits.

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
refined, then `status: in-progress`, `assignee: <you>`, a `## History` line for
each of the two, committed and **pushed before you begin**.

**Done** — the handback step of the sequence above: tick what now holds, move to
`review` (a story) or `done` (a task), reassign to the item's **`reporter`**,
append the two `## History` lines, comment, commit and push.

**Duplicate** — add `duplicates <target>` to the duplicate's `links` (a bare
number for another backlog item, a prefixed ref for a bug), set
`status: dropped`, append the history line, and comment saying which record it
was folded into. Put a one-line comment on the master too. `dropped`, not
`done`: `dropped` is the only terminal every type allows, and `done` would claim
the work was finished when nothing was built. Only the duplicate's file carries
the link — the master derives the inverse.

**Comment / status / assign** — as in `/bugs`: append per the header rule, edit
the frontmatter line in place, append a `## History` line for a `status`,
`assignee` or `reporter` change, and bump `updated`.

## Linking a bug to backlog work

A bug that turns out to be missing feature work, or a story that is being held
up by a defect, links across the two stores with a prefixed target:

```yaml
# in BUG-0042.md
links: [implements STORY-0007]

# in STORY-0007.md
links: [blocks BUG-0042]
```

`implements` is the verb for "this bug is really the missing feature work in
that story"; `blocks` and `blocked-by` are for a defect holding work up. Bare
numeric targets mean the *same* store; prefixed ones cross over and are
zero-padded to four. Only ever write the direction you're asserting — the two
lines above are two different assertions about the same pair, not one assertion
written twice, so a record only needs whichever one is true of it.

## What NOT to do

- Don't put bugs in the backlog store or features in the bug store. If a
  request is "make it stop crashing", it's a bug; if it's "make it able to",
  it's backlog.
- Don't copy an epic's `phase` or a parent's `due` down onto its descendants.
  Both are inherited, and a copy stops tracking the original the moment it moves.
- Don't treat a task as covered by its parent's acceptance criteria. It has its
  own, or none.
- **Don't hand an item back to "the human".** Hand it back to its `reporter`,
  falling back to the configured human only when the field is absent. Assigning
  work to the wrong person is worse than leaving it unassigned, because it stops
  looking like a gap.
- Don't set `reporter` on an item you didn't file. It is written once, at file
  time; an agent rewriting it is an agent erasing who asked for the work.
- Don't sign a comment as anything but **your own** agent name. Not `agent`, not
  the human, not somebody else's agent.
- Don't rewrite, re-order or delete a `## History` line — append below it. Don't
  put `## History` below `## Comments`, and don't start a history line with
  anything but `- `.
- Don't write a history line for a points, title or criteria edit. Three fields
  are recorded — `status`, `assignee`, `reporter` — and everything else is a
  diff.
- **Don't leave a record edit uncommitted**, and don't fold the human's stray UI
  edits into your own commit. A comment nobody can pull is a comment you did not
  write.
- Don't close a duplicate as `done`. `dropped` is the terminal for work that
  never happened.
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
- Don't try to put an epic in `review` or a task in `refined`. The UI rejects
  both, and the attempt means the item is the wrong type for the work it
  describes.
- Don't tick an acceptance criterion you haven't verified.
- **Don't call the BugDesk API, and don't ask the user to start the server.**
  Not to read a name, not to check the roster, not to save an item. It is
  optional tooling for the human, not a dependency of the file format — and an
  answer from a server pointed at another project is worse than no answer.
