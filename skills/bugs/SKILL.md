---
name: bugs
description: "Use when the user asks to file, investigate, comment on, reassign, or close a bug tracked in a BugDesk store (a directory of BUG-NNNN.md files) — or asks what's on your plate / assigned to the agent. Triggers on \"/bugs\", \"file a bug\", \"check my bugs\", \"comment on bug #N\", \"move bug #N to testing\", or any mention of a BugDesk bugs/ directory."
---

# /bugs

BugDesk tracks bugs as plain markdown files, one per bug, in a directory (the
"bug store"). There is no database and no required API round-trip: you read and
write these files directly, the same way you'd edit any other file in the repo.
A human triages the same files through the BugDesk UI (`./run.sh` in the
`bugdesk` checkout) — you never need that server running to use this skill,
though it's fine if it is (it reads the files fresh on every request, so
filesystem edits and the UI agree instantly).

## Usage

```
/bugs                          list bugs assigned to the agent, newest-updated first
/bugs list [filter]            list bugs — e.g. "/bugs list open", "/bugs list crash"
/bugs show <id>                print one bug: frontmatter + description + comments
/bugs new <title>              file a new bug (status: open, assignee: the human)
/bugs comment <id> <text>      append a comment as the agent
/bugs start <id>               CLAIM it: investigation + assignee you, committed and pushed
/bugs done <id>                hand it back: testing + assignee the human, committed and pushed
/bugs status <id> <status>     move a bug to open|investigation|testing|closed
/bugs reassign <id> <who>      change assignee
```

These are natural-language patterns, not a rigid CLI — "investigate bug 12",
"tell norman bug 7 is fixed", "file a bug about the crash on save" all map onto
the operations below. Use judgment about which operation(s) a request implies.

## Step 0 — find the bug store and the configured names

1. **Bug directory.** In order: the `BUGDESK_BUGS` environment variable if
   set; otherwise a `bugs/` directory at the root of the current project;
   otherwise ask the user. (This is the same resolution BugDesk's own server
   uses — see `bugdesk/server/Program.cs`'s `ResolveBugsDir`, if you have that
   repo checked out and want to confirm.)
2. **Agent name.** The `BUGDESK_AGENT` environment variable if set, else
   `agent`. This is the exact string you write as comment authors and as
   `assignee` when a bug is on you — it must match what BugDesk's server was
   started with (`BUGDESK_AGENT=...`), or the UI's "On agent" / "needs my
   reply" filters won't recognize your comments as yours. If a BugDesk server
   is reachable, `GET /api/config` returns the live `agentAuthor`/`humanAuthor`
   pair — prefer that over guessing when there's any doubt.
3. **Human name.** Same idea, via `BUGDESK_HUMAN` (default `reviewer`). This is
   who a bug reverts to when you move it to `testing`.

   Since BugDesk 0.2 the human's name usually does *not* come from an
   environment variable at all: it comes from a **per-user profile** the UI
   writes on first run — `.bugdesk/user-<name>.json`, git-ignored, beside the
   bug store. Several people can share one repo, each with their own name. So
   `GET /api/config` is the reliable source and an absent `BUGDESK_HUMAN` no
   longer means the name is `reviewer`. If no server is reachable, look for
   `.bugdesk/active.json` (it names the current profile's slug) before falling
   back to the default. Never write into `.bugdesk/` yourself — it is the
   human's, and it is git-ignored precisely so it stays that way.

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

Don't hardcode `"agent"`/`"reviewer"`/`"claude"`/`"norman"` in anything you
write — always use whatever you resolved here, since a project can configure
either name to anything.

## File format

One file per bug: `BUG-<id, zero-padded to 4 digits>.md`, e.g. `BUG-0042.md`.
`id` is a plain integer, assigned once, and never reused or renumbered.

```markdown
---
id: 42
title: "Save button does nothing on the settings page"
status: open
severity: medium
type: bug
subsystem: settings
assignee: reviewer
labels: [ui, regression]
links: [blocks 47, duplicates 12]
created: 2026-07-14
updated: 2026-07-14
---

## Description

Steps to reproduce, expected vs. actual, whatever the reporter gave you.

## Comments

### 2026-07-20 · agent

Root-caused to a missing event listener after the settings-page rewrite in
#38. Fix incoming.
```

Field notes:

- **status**: `open | investigation | testing | closed` — see Lifecycle below.
- **severity**: `crash | high | medium | low` (drives sort priority, crash first).
- **type**: `bug | regression | task`. The value `task` **displays as "Chore"**
  in the UI — the word "task" belongs to the backlog store (epic → story →
  task) and one word meaning two things across two stores is a real source of
  confusion. Keep writing `task` in the file; the rename is display-only, so no
  existing bug had to be rewritten.
- **assignee**: free text — whichever of the two configured names currently
  owns the bug. Always set explicitly; it is never derived from `status`.
- **labels**, **links**: bracketed, comma-separated. A link is `"<verb> <id>"`
  (`blocks 47`, `duplicates 12`, `blocked-by 9`, `related 3`) — store only the
  direction you're asserting; the inverse is a display-time computation in the
  UI, not something you also write into the other bug's file. A target may be
  **prefixed** to point into the backlog store — `relates STORY-7`,
  `blocked-by EPIC-1` — where a bare number always means another bug.
- **created**: set once, on file, never touched again.
- **updated**: bump to today (`YYYY-MM-DD`) on *any* edit to the file —
  frontmatter change or new comment.

### Comment headers

`### <YYYY-MM-DD> · <author>` — the parser takes everything after `· ` up to
the first `(` as the author, so `### 2026-07-20 · agent (after re-test)` parses
as author `agent`, note "after re-test". Don't put anything author-identifying
after the name without a `(` — an unparenthesized trailing word becomes part
of the author string and the comment silently stops matching that author's
filters.

New comments append to the end of the `## Comments` section (create the
section, with a blank line before it, if the bug doesn't have one yet). Newest
comment goes at the bottom of the file — BugDesk's UI reverses the order for
display, so don't pre-reverse it yourself.

## Lifecycle

```
open ──▶ investigation ⇄ testing ──▶ closed
        (closed may reopen to investigation on regression)
```

`open` is entry-only — nothing ever moves back to it. `closed` is only reached
from `testing`. How you move a bug through it is not a matter of taste — see
the next section.

## Working on a bug — the sequence

**This is required, and it is required in this order.** Every step, every bug,
however small the fix.

```
1.  CLAIM       status: investigation   assignee: <agent>
2.  COMMIT AND PUSH        ← the record only, before any work exists
3.  DO THE WORK            commit as you normally would
4.  HAND BACK   status: testing         assignee: <human>   + a comment
5.  COMMIT AND PUSH
```

**Why the claim is pushed before you start.** The bug store is committed and
shared — that is the whole point of it. Until your claim is *pushed*, nothing
anywhere says the bug is taken: the human sees it sitting in `open`, another
agent picks it up, and two of you fix the same thing in different ways. The
claim commit is the announcement, and pushing it is what makes it true for
anybody but you. A claim you kept locally until the end announced nothing.

It also means **a rejected push is how you find out you lost the race.** If step
2 is rejected, `git pull --rebase` and look at the record again. If it now shows
somebody else as `assignee` with `status: investigation`, they got there first —
**stop, do not work on it, and say so.** That is the protocol working, not a
problem to route around.

### The steps in detail

**1. Claim.** Set `status: investigation`, `assignee: <agent>`, `updated:`
today. Nothing else. If the bug is *already* `investigation` and already
assigned to you, you have claimed it — skip to step 3 rather than writing a
no-op commit.

If it is assigned to **somebody else** and not `closed`, do not take it. Ask
first; they may be mid-way through it with nothing pushed yet.

**2. Commit and push.** This commit contains the record file and nothing else:

```
BUG-0042: taking this on

status: open -> investigation, assignee -> <agent>
```

If the repo has no remote, commit and skip the push — say so once, so the user
knows the claim is local and the race window is still open.

**3. Do the work.** Commit it however the repo normally commits work. The
record does not change here.

**4. Hand back.** Set `status: testing`, `assignee: <human>`, and **append a
comment** saying what you found and what you changed. The status is what puts it
in their testing queue; the comment is what lets them verify it without reading
the diff. A handback with no comment is a bug they have to re-investigate to
review.

If you could not fix it, do **not** move it to `testing` — `testing` means
"there is something here to verify". Leave it in `investigation`, comment with
what you learned and what is blocking, and reassign to the human only if you
need something from them.

**5. Commit and push.** The record change, plus any work not already committed.

### When not to follow it

Only when the user says so — "don't commit this yet", "just look, don't touch
the record". Follow that, and say plainly that the bug is unclaimed so they know
the state it is in. The *size* of a change is never a reason to skip the claim:
a one-line fix collides with somebody else's one-line fix exactly as badly.

## Operations

**List** — `grep`/read frontmatter across `BUG-*.md` in the bug directory;
filter and sort as asked (severity: `crash` > `high` > `medium` > `low`; the
default view excludes `closed`). Report id, title, status, severity, assignee.

**Show** — read one file, render frontmatter + `## Description` +
`## Comments` in order.

**New** — scan existing `BUG-*.md` filenames for the current max `id`, use
`max + 1`. Write the file per the format above: `status: open`,
`assignee: <human>` (a human files it; only re-assign to the agent once you
start investigating it yourself), `created`/`updated` both today.

**Comment** — append per the Comment headers rules above; bump `updated`.

**Status / reassign** — edit the `status:` and/or `assignee:` frontmatter
lines in place; bump `updated`. Don't touch anything else in the file.

## Feature work lives elsewhere

Bugs are what broke; **planned feature work belongs in the backlog store** and
is driven by the sibling `/backlog` skill (`EPIC-`/`STORY-`/`TASK-NNNN.md` in
`backlog/`, usually right beside `bugs/`). If a request is "make it stop
crashing" it's a bug; if it's "make it able to", file it with `/backlog`
instead and link the two if they're related.

The one grey area is `type: task` on a bug — that stays for chores that come
*out of* triaging a bug ("delete the dead flag we found"). Anything with
acceptance criteria and an estimate is a backlog item, not a bug of type task.

## What NOT to do

- Don't invent a third author name — there are exactly two configured roles.
- Don't derive `assignee` from `status` in your head and skip setting it —
  always write it explicitly, per bug, per transition.
- **Don't start work before the claim is pushed**, and don't batch the claim
  into the commit that carries the fix. A claim that arrives with the work
  announced nothing to anyone.
- **Don't work on a bug somebody else has claimed** because the fix looks
  obvious to you. Ask them.
- Don't renumber or reuse an `id`, even for a bug you're deleting/replacing.
- Don't restart or require the BugDesk server for any of this — it's optional
  tooling for the human, not a dependency of the file format.
