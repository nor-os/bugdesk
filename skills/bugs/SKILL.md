---
name: bugs
description: "Use when the user asks to file, investigate, comment on, reassign, or close a bug tracked in a BugDesk store (a directory of BUG-NNNN.md files) — or asks what's on your plate / assigned to the agent. Triggers on \"/bugs\", \"file a bug\", \"check my bugs\", \"comment on bug #N\", \"move bug #N to testing\", \"who reported bug #N\", or any mention of a BugDesk bugs/ directory."
---

# /bugs

BugDesk tracks bugs as plain markdown files, one per bug, in a directory (the
"bug store"). **The files are the whole interface.** You read and write them
directly, the same way you'd edit any other file in the repo — there is no
database, no server to start, and no HTTP call anywhere in this skill.

A human triages the same files through the BugDesk UI (`./run.sh` in the
`bugdesk` checkout). Whether that is running changes nothing: it reads the files
fresh on every request, so filesystem edits and the UI agree instantly.

**Do not call the BugDesk HTTP API.** Not as a first choice, not as a fallback.
Everything it would tell you — the names, the roster, the records — it reads
from the files you already have, and a server that happens to be listening on
this machine may be serving a *different* project: taking an answer from it is
how you end up signing comments as somebody else's name. `curl` failing because
nothing is listening is the better half of that failure; being answered by the
wrong store is the half that does damage.

## Usage

```
/bugs                          list bugs assigned to the agent, newest-updated first
/bugs list [filter]            list bugs — e.g. "/bugs list open", "/bugs list crash"
/bugs show <id>                print one bug: frontmatter + description + comments
/bugs new <title>              file a new bug (status: open, assignee and
                               reporter: the human who filed it)
/bugs start <id>               CLAIM it: investigation + assignee you,
                               committed and pushed
/bugs done <id>                hand it back: a comment, then testing +
                               assignee the REPORTER, committed and pushed
/bugs comment <id> <text>      append a comment signed with YOUR agent name
/bugs status <id> <status>     move a bug to open|investigation|testing|closed
/bugs reassign <id> <who>      change assignee
/bugs duplicate <id> <target>  close it as a duplicate of another record
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
2. **The two names.** The HUMAN is the person this checkout belongs to — the
   default `reporter` on anything you file here, and the fallback owner of a
   record whose `reporter` predates the field; the AGENT is the exact string you
   write as comment author and as `assignee` when a bug is on you. They have to
   match what the UI resolves, or its "On agent" / "needs my reply" filters
   won't recognise your comments as yours — so resolve them the way the server
   does, **from the same files**:

   1. **Which profile.** `BUGDESK_USER` if set, slugified (lower-cased; each run
      of non-alphanumeric characters becomes one `-`; trimmed of `-`). Otherwise
      the `user` field of `<config>/active.json`.

      No `active.json` and exactly one `user-*.json`? That one. This is the
      normal state of a `BUGDESK_HUMAN=... ./run.sh` deployment, not a broken
      one: seeding writes the profile but deliberately leaves `active.json`
      alone, so one person's scripted run cannot repoint the checkout's default
      for everybody else. Several profiles and no `active.json`: fall through to
      the environment, and if that is empty too, **ask** rather than guess which
      of several people you are.
   2. **The names.** `<config>/user-<slug>.json` — `name` is the human,
      `agentName` is the agent.
   3. **Fallbacks, in order.** `BUGDESK_HUMAN` / `BUGDESK_AGENT`, then
      `reviewer` / `agent`.

   `<config>` is the `BUGDESK_CONFIG` environment variable if set, otherwise
   `.bugdesk/` **beside the store** — `<bug store>/../.bugdesk`.

   **The profile beats the environment**, which is why it is read first.
   `BUGDESK_HUMAN`/`BUGDESK_AGENT` only seed a name when no profile exists yet;
   once the human has set one — through the first-run screen or "change your
   name" — the file is the answer and the variables are ignored. A
   `BUGDESK_HUMAN` you can see in your environment may name somebody the user
   has since changed away from.

   A bug goes back to its **`reporter`**, which is not necessarily the human you
   resolve here: on a shared store, somebody else filed half of them.

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
assignee: norman
reporter: norman
labels: [ui, regression]
links: [blocks 47, implements STORY-0007]
created: 2026-07-14
updated: 2026-07-14
---

## Description

Steps to reproduce, expected vs. actual, whatever the reporter gave you.

## History

- 2026-07-20 · norman_agent · status: open -> investigation
- 2026-07-20 · norman_agent · assignee: norman -> norman_agent

## Comments

### 2026-07-20 · norman_agent

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
- **reporter**: who asked for this — the person the bug goes back to when you
  hand it over. Free text, same vocabulary as `assignee`. **Written once, when
  the file is created, and never again** — not when you claim it, not when you
  hand it back. `assignee` says whose court the bug is in right now; `reporter`
  says whose bug it is. On a store two or three people file into, "back to the
  human" means back to *your* human, and the bug lands on somebody who has never
  seen it. A record written before this field existed has no `reporter:` line —
  read that as the configured human and **leave the file alone**. A backfilled
  guess is indistinguishable on disk from a recorded fact, which is worse than
  an honest gap.
- **labels**, **links**: bracketed, comma-separated. A link is
  `"<verb> <target>"`, and the verbs are `duplicates`, `blocks`, `blocked-by`,
  `requires`, `caused-by`, `relates-to` and `implements` — those seven, because
  the UI derives the inverse of each one ("is blocked by", "is implemented by")
  and a verb it doesn't know is dropped on read, silently. (`related` is read as
  an old spelling of `relates-to`; don't write new ones.) Store only the
  direction you're asserting; the inverse is a display-time computation, not
  something you also write into the other record's file. A **bare number means
  this store** — `blocks 47` in a bug is bug #47. A **prefixed target crosses
  over** and is zero-padded to four: `implements STORY-0007`,
  `caused-by EPIC-0001`. `STORY-7` still reads; write the padded form, and
  nothing will rewrite one you left.
- **created**: set once, on file, never touched again.
- **updated**: bump to today (`YYYY-MM-DD`) on *any* edit to the file —
  frontmatter change or new comment.

### Who you sign as

Sign every comment with **the agent name you resolved in step 0** —
`norman_agent`, not the bare word `agent`, and never the human's name or another
collaborator's agent. `agent` is the fallback the server uses when nothing is
configured; on a store whose collaborators are `alice_agent` and `priya_agent`
it matches nobody, so a comment signed that way sits outside every "on agent"
filter the UI has — and one signed as the human tells them they already answered
themselves.

**Comment on every bug you touch, every time you touch it.** A status change
says where the bug is; only the comment says what you did to it. There is no bug
small enough to skip this, including the ones where the answer was "not
reproducible" or "already fixed in #38". If the bug is somebody else's — you
commented, you reassigned it, you closed it as a duplicate — say so, and name the
person it now belongs to. A handback with no comment is a bug they have to
re-investigate in order to review.

### Comment headers

`### <YYYY-MM-DD> · <author>` — the parser takes everything after `· ` up to
the first `(` as the author, so `### 2026-07-20 · agent (after re-test)` parses
as author `agent`, note "after re-test". Don't put anything author-identifying
after the name without a `(` — an unparenthesized trailing word becomes part
of the author string and the comment silently stops matching that author's
filters.

An author name may contain underscores — `norman_agent` is the normal case, and
the `_(imported)_` marker is still recognised after it. (It was not, until
recently: the header failed to match at all and the comment was folded into the
one above it. If you are looking at a store whose comments predate that fix and a
thread looks welded together, that is why.) What still breaks the parse is an
unparenthesized trailing word: put a note in `(round brackets)` or leave it out.

New comments append to the end of the `## Comments` section (create the
section, with a blank line before it, if the bug doesn't have one yet). Newest
comment goes at the bottom of the file — BugDesk's UI reverses the order for
display, so don't pre-reverse it yourself.

### History entries

`## History` is the record's audit trail: who moved it, when, and from what to
what. It sits **after `## Description` and strictly before `## Comments`** — a
History section written below the thread is read as part of the last comment's
body, and the whole section stops existing as far as BugDesk is concerned.

One entry per line, oldest at the top, appended and never rewritten:

```
- 2026-09-12 · norman_agent · status: investigation -> testing
- 2026-09-12 · norman_agent · assignee: norman_agent -> norman
```

Same `·` separator as a comment header, twice. The arrow is the two-character
ASCII `->`, the same one you write in a commit message. Three fields are recorded
and no others — `status`, `assignee`, `reporter` — the three that say where a bug
stands and whose it is. A severity or title edit is a diff; a reassignment is a
decision, and an audit trail is for decisions. An empty value is written
`(unset)`. One line per field: a transition that moves status **and** assignee
writes two lines sharing the date and the actor.

**Every line starts with `- `.** That is not decoration. A line beginning
`status:` at the left margin is exactly what the frontmatter reader looks for, so
one sitting in the History section would be read as the bug's real status and
then overwritten by the next edit.

**Write a line for every status, assignee or reporter change you make**,
including the claim and the handback, and only when the value actually changes —
two consecutive lines saying the same thing say less than one. Don't write a
"filed" entry: `created:` and `reporter:` already say that, and BugDesk shows it
as the last row for you. A record that has never changed hands has no
`## History` section; create it, with a blank line before it, the first time it
does. And don't write an `##` heading inside a comment — the section finders
search the whole file for one.

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
1.  CLAIM        status: investigation   assignee: <your agent>   + history
2.  COMMIT AND PUSH        ← the record only, before any work exists
3.  DO THE WORK            commit and push it the way the repo normally does
4.  COMMENT                what you found and what you changed
5.  HAND BACK    status: testing         assignee: <the reporter>  + history
6.  COMMIT AND PUSH        ← 4 and 5 are one edit and one commit
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

### Every record edit is committed and pushed

Steps 2 and 6 are the two the sequence names, but the rule is broader and it has
no exceptions: **a comment, an assignment change, a status change, a new bug —
any edit to a record file — is committed and pushed the moment you make it.**

The bug store is committed and shared; that is the whole point of it. An
uncommitted comment notifies exactly the person you wrote it for: nobody. An
unpushed reassignment leaves the work looking unclaimed. A status change sitting
in your working tree is a queue the human is reading a stale version of.

**The human edits these files too.** BugDesk's UI writes the record straight to
disk and does not commit anything — that is deliberate, because a web page
running `git push` on somebody's behalf is not a thing you want to discover
later. So **`git status` the store before you claim anything.** If there are
uncommitted record files, they are the human's UI edits: commit and push them
**first, as their own commit** (`BUG-0042: record edits from the UI`), so your
claim commit carries only your claim and the store never sits dirty.

**`git pull --rebase` before you read the record, not only after a rejected
push.** You are about to act on what it says; acting on a version three commits
behind is how two agents claim the same bug five minutes apart.

One commit per record edit, the record file and nothing else in it:

```
BUG-0042: handing back to norman

status: investigation -> testing, assignee -> norman
```

```
BUG-0042: comment
BUG-0042: reassigned to priya
```

If the repo has no remote, commit and skip the push — say so once, so the user
knows the store is local and nobody else can see any of this.

**And push the code work too, before the handback.** A handback that announces a
fix nobody can pull is worse than no handback: it moves the bug into somebody's
testing queue with nothing in it to test.

### The steps in detail

**1. Claim.** Set `status: investigation`, `assignee: <your agent>`, `updated:`
today, and append the two `## History` lines that record those two moves.
Nothing else — `reporter:` is not yours to touch. If the bug is *already*
`investigation` and already assigned to you, you have claimed it — skip to step
3 rather than writing a no-op commit and a history line that records nothing.

If it is assigned to **somebody else** and not `closed`, do not take it. Ask
first; they may be mid-way through it with nothing pushed yet.

**2. Commit and push.** This commit contains the record file and nothing else:

```
BUG-0042: taking this on

status: open -> investigation, assignee -> <agent>
```

If the repo has no remote, commit and skip the push — say so once, so the user
knows the claim is local and the race window is still open.

**3. Do the work.** Commit and push it however the repo normally does. The
record does not change here.

**4. Comment.** Append a comment, signed as your own agent, saying what you
found and what you changed. Every bug, every time — see *Who you sign as*. The
status is what puts the bug in somebody's testing queue; the comment is what
lets them verify it without reading the diff.

**5. Hand back.** Set `status: testing`, `updated:` today, and set `assignee:`
to the bug's **`reporter`** — read out of the file, not assumed. Append the two
`## History` lines. Only when the record has no `reporter:` line at all does the
handback go to the human you resolved in step 0, and say so in the comment
("no recorded reporter, back to norman"), so the next person can tell a guess
from a fact.

If you could not fix it, do **not** move it to `testing` — `testing` means
"there is something here to verify". Leave it in `investigation`, comment with
what you learned and what is blocking, and reassign to the reporter only if you
need something from them.

**6. Commit and push.** The record change — steps 4 and 5 are one edit and one
commit — plus any work not already committed and pushed.

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
`assignee: <human>`, `reporter: <the same human>` — or, if the user is relaying
somebody else's report, that person — `created`/`updated` both today. No
`## History` section: nothing has happened yet. Commit and push it.

**Comment** — append per the rules above, signed as your agent; bump `updated`.
No history line: a comment is already visible as itself. Commit and push it.

**Status / reassign** — edit the `status:` and/or `assignee:` frontmatter lines
in place, append the matching `## History` line for each one you changed, bump
`updated`. Don't touch anything else in the file. Commit and push it.

**Duplicate** — add `duplicates <target>` to the duplicate's `links` (a bare
number for another bug, a prefixed ref for a backlog item), set `status: closed`,
append the history line, and comment saying which record it was folded into. Put
a one-line comment on the master too, so somebody reading it knows what arrived.
Only the duplicate's file carries the link — the master derives the inverse.

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

- Don't invent a name. Use the two you resolved in step 0, or one already in the
  collaborator roster — with a reporter to hand back to, a bug can legitimately
  sit with any of them.
- Don't sign a comment as anything but **your own** agent name. Not `agent`, not
  the human, not somebody else's agent.
- **Don't hand a bug back to "the human".** Hand it back to its `reporter`,
  falling back to the configured human only when the field is absent. Assigning a
  bug to the wrong person is worse than leaving it unassigned, because it stops
  looking like a gap.
- Don't set `reporter` on a bug you didn't file. It is written once, at file
  time; an agent rewriting it is an agent erasing who asked for the work.
- Don't rewrite, re-order or delete a `## History` line — append below it. Don't
  put `## History` below `## Comments`, and don't start a history line with
  anything but `- `.
- **Don't leave a record edit uncommitted**, and don't fold the human's stray UI
  edits into your own commit. A comment nobody can pull is a comment you did not
  write.
- Don't finish a bug without commenting on it, however small the fix.
- Don't derive `assignee` from `status` in your head and skip setting it —
  always write it explicitly, per bug, per transition.
- **Don't start work before the claim is pushed**, and don't batch the claim
  into the commit that carries the fix. A claim that arrives with the work
  announced nothing to anyone.
- **Don't work on a bug somebody else has claimed** because the fix looks
  obvious to you. Ask them.
- Don't renumber or reuse an `id`, even for a bug you're deleting/replacing.
- **Don't call the BugDesk API, and don't ask the user to start the server.**
  Not to read a name, not to check the roster, not to save a bug. It is optional
  tooling for the human, not a dependency of the file format — and an answer
  from a server pointed at another project is worse than no answer.
