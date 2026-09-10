# Changelog

Notable changes to BugDesk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-09-10

### Added

**Tracker mode** (`./run.sh --tracker`, or `BUGDESK_MODE=tracker`). A second
job for the same files: a follow-up list for work handed to other people, most
of whom never open the checkout. Nobody else updates it, which is the fact the
whole mode is designed around.

It **adds and relabels; it never removes**. The bug store is still there, the
markdown on disk is unchanged, and a store written in one mode opens correctly
in the other — `project`, `due` and `reporter` are legal records everywhere,
they are simply not *offered* outside tracker mode.

- **A `project` level above epics** (`PROJ-NNNN.md`, one id sequence with the
  other three). A story or a task may hang **directly off a project**: most
  tracked work is one or two levels deep, and an epic that exists only to hold
  one task is a record nobody reads. A project is a container, so it is never
  `refined` and never in `review` — its ladder is `draft → in-progress → done`,
  and the bridge rejects anything else with the ladder in the error.
- **Target dates.** `due: YYYY-MM-DD`, or **empty** — and empty is a real state,
  not a missing value: it means nobody has committed to a date, which is exactly
  what a tracker exists to surface. The bridge **rejects** a date it cannot
  parse rather than storing it, because a date that never parses can never be
  overdue; it would sit in the one blind spot this tool must not have.
- **"Overdue" is computed in the browser**, from the reader's own today. A
  server answering with *its* today is wrong the moment a tab is left open past
  midnight or somebody is in another timezone. One definition (`dueState`) is
  read by the dashboard, the board's Due column and the `dueState` filter field,
  so the three cannot disagree. `none` (no date) and `done` (closed) are
  deliberately off the schedule rather than being treated as "on time".
- **A `reporter` field** — whose *list* something is on, as opposed to
  `assignee`, whose court it is in. Without it "what did I hand out" has no
  answer at all. Stamped on create from the configured human name, and offered
  as a dashboard scope rather than as the default, because records written
  before it existed carry none.
- **The dashboard**, the landing page in tracker mode: Overdue (worst first,
  with a name on every row), Due in the next 7 days, Who has what (sorted by
  overdue count, then by how late their worst item is — the list is read
  top-down and stopped at, so the order *is* the priority), and **Needs a name
  or a date**. That last section is the point: a tool that reports only on the
  work it knows about is most confident exactly where it is least complete.
- **A Due column** on the board, sorted chronologically and painted as a pill;
  **Projects** in the left rail in place of Work packages, each with its overdue
  count; and rail views that lead with Overdue instead of Needs refinement.
- **`/tracker`**, a Claude Code skill, with
  [`INTAKE.md`](skills/tracker/INTAKE.md) — the operation the mode exists for:
  turning meeting minutes, an email thread or a chat log into tracker edits. It
  shows the whole changeset before writing anything and records a provenance
  comment on every item it touches, quoting the source and dated to the
  *source's* date. Its rules are mostly refusals, because an agent writing many
  records at once from prose, about people who are not there to correct it, is
  the most dangerous thing in this repo: never invent a date, never move one
  without saying why, a missed date with no replacement stays missed, and if the
  source does not say it then it did not happen.
- `examples/tracker/` and `--tracker --seed`, so the dashboard has something to
  be late about on a first run. In tracker mode the server does the seeding,
  because it owns the paths and two places computing them is two places to get
  them wrong.

### Changed — tracker mode is its own app, not a mode of a repo

- **A tracker's records leave the repo.** They live under the user's own BugDesk
  directory — `~/.bugdesk/<project>/` (`%APPDATA%\BugDesk\<project>\` on
  Windows) — with `tickets/`, `attachments/` and `config/` inside, one folder per
  tracked project. `bugs/` and `backlog/` inside a checkout were the wrong home
  in every respect, including the names: a tracker is a record of work handed to
  other people, it is not about the code in any repo, most of the people in it
  have never seen that repo, and committing it would put private notes about
  colleagues into a shared history. The project is named by the directory the
  tracker was started from; `--project`, `BUGDESK_TRACKER_PROJECT` and
  `BUGDESK_TRACKER_HOME` override.
- **The port is picked automatically** in tracker mode — the next free one from
  8766. A tracker is a personal tool opened alongside a BugDesk already running
  on a repo, so a fixed port collides with the thing you were already using. An
  explicit `ASPNETCORE_URLS` still wins: the automatic choice fills a gap, it
  does not overrule a decision.
- **The top bar carries Tracker and nothing else.** Bugs and Tickets are gone as
  top-level entries — the bug store does not exist in this mode, and the ticket
  list is reached *from* the dashboard rather than being a competing place to be.
  The bug types are dropped from the New item Type select for the same reason,
  and the top-bar Search uses the shared item picker instead of the bug mask.
- **The server finds its own assets by walking up from the binary** as well as
  the working directory. "One above the working directory" held only while
  BugDesk was always started by `run.sh`, which cd's into `server/` first — a
  tracker is started from wherever the user happens to be, and getting this
  wrong meant silently serving no UI at all.

**Two ways to open a record without losing your place**, in the bug queue, the
ticket list and the Tracker dashboard alike. Every list opened things by
replacing something, which is right for working through a queue and wrong for
what triage mostly is — two records side by side.

- **Drag a row onto any tile** and that tile displays it. Every tile that can
  take the drop is outlined while a record is in flight; panels are not offered,
  because dropping a bug onto the filter rail means nothing. Dragging out of
  BugDesk entirely pastes the reference, which is the only thing an outside
  program could do with it.
- **Ctrl-click** (⌘ on a Mac) opens a record in a floating window, or in a
  background tab — **Settings › General › Records**. Both answers are reasonable
  and the difference is about how someone works, so it is a setting rather than a
  decision made for everybody.
- **Shift-click is deliberately untouched.** It is the table's range-select and
  the one selection gesture with nowhere else to go.

One document-level listener pair serves every tile, rather than per-tile wiring:
tiles are created, destroyed and repainted constantly, and a drop target bound to
a tile element stops working the first time that tile repaints.

### Changed

- **Settings only offers what BugDesk actually does.** `@flexdesk/core` registers
  a schema written for a different application — a simulation IDE with ETL
  pipelines, an AI assistant, an autosaving editor, a projects directory — and
  BugDesk inherited the whole of it while reading almost none of it. An Auto-Save
  section over a store that has no autosave is not a harmless leftover: it is the
  app promising something it does not do, with no way for the user to tell which
  of the rows in front of them are real. Down from ~25 rows across five
  categories to 13 across three.

  It is an allow-list, and a test keeps it honest in **both** directions: every
  offered setting must be read somewhere in `ui/js` (or be an action button), and
  every setting the app reads must be offered — or named in `HIDDEN_SETTINGS`
  with the reason. `modules.autoCreateDefaults` is the one entry there: it *is*
  read on boot, by a module loader looking for an EcoSim modules directory a bug
  tracker does not have, and its row read "create the default Economy module".
  The bar for a settings row is not "some code branches on it", it is "the user
  can observe the difference".

- **Settings dropdowns are the app's own control**, not the browser's. A bare
  `<select>` is drawn by the platform, so it ignored the app's tokens entirely —
  a light popup over a dark UI on most of them — and it was the one control on
  that page that did not look like the app it is part of. The `<select>` stays as
  the value carrier, so the page's existing read/write wiring needed no changes.

- **The Collaborators editor is a real managed window**, with the app's own
  chrome, drag, resize, focus trap and z-stacking, instead of a hand-rolled
  overlay. The overlay was written when this could open on top of another modal,
  which it no longer can — every caller closes its own dialog first — and it cost
  more than the stacking it bought. Most visibly: **its inputs had no styling at
  all.** `.ea-tin` is scoped to `.td-page`/`.td-modal`/`.td-nav`/`.td-rpanel`, and
  a bare overlay is none of those, so every field rendered as a raw browser input
  — white box, wrong font, wrong size — in the middle of a dark app. The roster
  rows now carry `ea-modal__row`, which is the class the modal stylesheet hangs
  its input styling off; a test asserts every field lives inside one and fails
  against the old markup. The Agent column is dropped entirely in tracker mode,
  where nobody has one.

- **Clicking a row on the Tracker dashboard now opens a tab in the dashboard's
  own tile**, rather than splitting a pane beside it. The split kept the
  dashboard on screen, which was the point, but at the cost of two half-width
  tiles — and a ticket read at half width is a ticket whose description wraps
  every four words. A tab keeps the full width for what you are reading and the
  tracker exactly where you left it, one click away. **Open beside the tracker**
  moved to the right-click menu, as the deliberate choice it is rather than the
  default.

**Acceptance criteria can be written when a record is filed**, rather than only
after it exists. That is when what "done" means is freshest — filing a story and
immediately reopening it to say so was ceremony.

**A task no longer inherits its parent's acceptance criteria.** It never did:
nothing anywhere copied or resolved them, so the claim left a task looking
covered by a list that describes something else, and its own empty criteria
looking like a normal state rather than a gap. A task now has its own, or none,
and is asked for them like anything else. Its refinement panel reports its own
criteria instead of pointing at the parent's. **The ladder is unchanged** — a
task still goes `draft → in-progress` with no `refined` — because that was
always about the transition, not about the criteria; the reason given for it has
been corrected everywhere it appeared. A project is now the only type not asked
for criteria: it is a container, and what "done" means for it is that the work
inside it is done.

**Both things the date field cannot say are said the same way**: small pills on
the same line as the input, differing only in what they mean — `inherited`
dashed and grey because it is a statement of fact, `after PROJ-0001` solid and
amber because it is a problem. Either can shorten to an ellipsis before the row
wraps, with the detail in the title, so a long reference cannot push the layout
around.

**An inherited target date shows in the field**, badged `inherited`, rather than
as a note on a second line — an empty input beside a line of text reads as "no
date" when there is one. It is writable either way: type over it and it becomes
this record's own, clear it and it goes back to inheriting, and the badge goes
the moment you edit rather than after a save.

What makes it an override is **editing** it, not saving the page. Nothing turns
an inherited date into an owned one because you changed the title and hit Save —
a silent conversion would stop the item tracking its parent with nothing on
screen having said so.

**Target dates are inherited**, exactly as `phase` is. An empty `due` resolves to
the nearest dated ancestor's — a task under a story due on the 14th is due on the
14th, and no longer shows up in the dashboard's "needs a date" pile when somebody
has in fact said when. Setting a date on the item overrides it; clearing it goes
back to inheriting. Nothing is copied down, because a copy stops tracking the
original the moment it moves. Everything that asks "when is this due" — the
dashboard's sections and sorting, the board's Due column, the person rollup —
reads the date in force rather than the authored one.

**A sub-item due after its parent is flagged**, on the item page, the board's Due
column and the dashboard rows. Flagged rather than refused: plans slip one piece
at a time, and forbidding it would only make people enter dates they do not mean.
But it always means the parent's date is already wrong and nobody has moved it —
whoever is watching the parent still thinks it lands on the 14th. Only an item's
OWN date can overrun (an inherited one *is* the ancestor's), the nearest
overrun ancestor is the one named, and closed work is exempt.

**Descriptions are editable.** The item page rendered one and offered no way to
change it, so the one field with room to say *why* was write-once: you could set
it while filing and never again. Same shape the acceptance criteria already use
— rendered markdown, the composer one click away, paste-a-screenshot included.
An open editor now counts as unsaved work, so an incoming change asks before
replacing it instead of discarding a paragraph mid-sentence; `dirty` only
tracked the frontmatter fields, which left the largest thing on the page
unprotected.

**Pasted URLs are linked, and shortened to something readable.** A record
accumulates links and pasted links are long — one can be wider than the tile it
sits in, and a wrapped line of query parameters buries the sentence it was
evidence for. A bare URL becomes a link whose text drops the scheme, a `www.`
and the middle of a long path (`build.example.com/jobs/…/report.html`), with the
full URL in the title. One ellipsis, ever: whether the elided part is a path or
a query does not change what the reader does about it. A link with a label keeps
its label, a URL in a code span stays literal, sentence punctuation is not
swallowed, and `javascript:`/`data:` are not linked at all.

Titles are deliberately **not** fetched. That would mean the browser reaching out
to every host mentioned in every record — blocked by CORS most of the time, slow
the rest, and a quiet promise that reading a bug report tells somebody's server
you read it.

**No `<name>_agent` in tracker mode.** A tracker records work handed to people,
none of whom has an assistant in that store, so an agent beside every one of them
is a row in every picker that can never legitimately be chosen. Nothing derives
one now: not the profile, not the roster, not the assignee list, and the Agent
name field is gone from the identity dialog. The bridge decides
(`ProjectConfig.AgentsAssignable`) and reports it, so the two halves cannot
disagree about who exists. Bug mode is unchanged.

**Finished work gets out of the way.** A store accumulates closed records for
ever; after a year they are most of it, and a surface that lists them alongside
live work buries the handful of things you were looking for. Closed work —
`done`, `dropped`, and a `closed` bug — is now hidden on the surfaces you go to
in order to ACT on something, and untouched on the ones whose job is to look
something up:

- the **search dialog** (choosing a parent, adding an existing child, the
  tracker's Search) hides it behind a **Closed** chip, and the result count says
  how many were held back so the chip is discoverable exactly when it would help;
- the **search page** does not search it, with an **Include closed** checkbox —
  though asking for `closed` in the Status field still wins, because somebody
  who typed it means it;
- the left rail's **Projects** / **Work packages** tree lists only unfinished
  ones, and its badges count only open items. The rail is a place you navigate
  FROM: a finished project is not somewhere you are going, and a count that
  includes everything ever closed under it grows without bound.

The **Done** / **Closed** rail view is deliberately unchanged — it is the one
surface whose whole job is to answer "what did we finish" — and so is
**Everything**. The item a field currently points at is never hidden either,
whatever its status: a picker that cannot show what the field holds makes the
field look empty.

**Deleting a record**, in tracker mode. A tracker is one person's follow-up list
and is not in a repo, so `dropped` is not the only sensible answer and
`git checkout` is not available if you regret one. Offered on the ticket page and
from the right-click menu on the dashboard and the ticket list; a shared backlog
still says drop it, with a comment, because the decision not to build something
is worth keeping.

- Deleting something **with work under it asks first**: keep the descendants
  (they take the deleted item's own parent, so the tree closes over the gap) or
  delete the subtree, named in the confirmation. The bridge refuses a bare
  `DELETE` of anything with descendants — 409 with the count — so the question
  cannot be skipped by accident.
- **Nothing is unlinked.** Files move to `trash/` in BugDesk's config directory,
  which is out of git's way in both modes and — importantly — out of the *store*
  directory the file watcher is pointed at.

**Clicking a name in the Inspector shows that person's active work.** A panel
that says "bo — 7 in flight" and does nothing when you click it has told you the
least interesting half of what it knows. It opens the same set the count is of,
in whichever store the panel is currently reporting on.

### Fixed

- **"Open in a background tab" was not in the background.** It used the WM's
  `transient` flag, which in this codebase means "not archived" — not "not
  switched to". `appendLeafTab` activates the tab it appends, so Ctrl-click
  opened the record and took you straight to it, which is exactly what an
  ordinary click already does: the setting made no observable difference. Tabs
  can now be appended without stealing the screen or the tile's focus, which is
  the entire point of the gesture.

- **Clicking a name in the Inspector did nothing** — the actual cause, found on
  the third report. The panel repainted on every `wm:changed`, and the window
  manager fires that from `tree.focus()`, which runs on **mousedown**. So
  pressing on a row replaced the panel's DOM before the release: the row no
  longer existed at mouseup, the browser dispatched `click` on an ancestor
  instead, `closest('[data-member]')` found nothing, and the handler did nothing.
  It looked like a dead handler; it was the panel pulling the row out from under
  the click.

  Invisible to a test that calls `.click()` — there is no press, no release, and
  no repaint in between — which is why it survived two rounds of "I tested this
  and it works". The panel now repaints only when the store it is reporting on
  changes, or when a write says the numbers moved, which is what the left rail
  had always done and why the rail never had the bug. The test asserts the row is
  the SAME NODE after a focus change, and fails against the old code.

- **Two earlier fixes on the way to it**, both real and both kept: the first
  `TileTree.swapToPage` decides whether a page switch must surface the caller's
  target or may simply restore the tabs that page last had. It asked two
  questions — is a specific entity wanted (`props.id`), and is this a page kind
  other than the nav category itself — and **missed the third: was this page
  asked for with particular props.** "Everything open on bo" is `kind: 'backlog'`
  with an `expr` and no id: no entity, and `backlog` is its own category. So it
  fell through to the bare restore and put back whatever the Backlog page last
  held — a ticket you had been reading, usually — and the tile did not visibly
  change at all.

  A bare page switch still restores as-is, which is the point of archiving tabs:
  a top-nav chip carries no props and must put back the tab you left open. Both
  behaviours are now tested against the real `TileTree` rather than a mock of the
  window manager — no mock could have caught this, because the click, the handler
  and the call were all correct.

- **Two kinds in one section disagreed about which section that was.**
  `topNavFor` is a single hop, so in tracker mode `item` reported `backlog` while
  `backlog` reported `tracker`, and `home` — the landing tile, which renders a
  section's own page — declared no section at all. Every `openInPrimary` from
  those tiles was therefore treated as a cross-page swap. Both now declare the
  section they are in, and a test asserts every page kind declares one.

- **Drag-and-drop did not work from either table.** `DataTable` calls
  `renderCell(td, …)` while the cell is still DETACHED — it is appended to its
  `<tr>` afterwards — so `td.parentElement` was `null` and marking the row
  through it silently did nothing. It shipped working on the Tracker dashboard,
  whose rows carry `draggable` in their markup, and broken everywhere a table is
  used. Every *cell* is now the drag handle, which also means you no longer have
  to aim for a particular column. The test builds a cell the way DataTable does
  and fails against the old code.
- **A drop could be refused outright depending on the browser.**
  `dataTransfer.types` is a plain array in some engines and a `DOMStringList` in
  others, and `DOMStringList` has no `.includes` — the call threw, so nothing
  called `preventDefault`, so no drop was ever accepted. Silently.
- **`PROJ-*.md` was never watched.** The file watcher listed the three original
  prefixes by hand, so a project record created or changed outside BugDesk never
  reached an open browser while every other type did. It is driven off
  `BacklogItem.Prefixes` now, so a fifth type cannot be half-added.

- **The Children list showed a green circle with "Done" in it, under the list.**
  A regression from the tracker commit: `.bd-childrow` declares five grid
  columns and the row had grown a sixth cell (the assignee), so the status pill
  wrapped onto an implicit row and landed in the 15px glyph column — a pill
  squeezed to a circle. jsdom has no layout and cannot see a wrapped grid, but
  the arithmetic behind it is checkable from the stylesheet text, so a test now
  compares the declared column count against the cells the markup emits. It
  reproduces this exact bug when the old template is put back.

- **Clicking a ticket on the Tracker dashboard took the dashboard off screen.**
  You clicked a late ticket to see who had it and lost the list of everything
  else that was late. Two causes: the ticket page opened in the dashboard's own
  tile, and — because `item` → `backlog` is a single hop and `backlog` is not a
  top-level section in tracker mode — the lit chip and the left rail lost their
  section entirely. Tickets now open in a pane **beside** the dashboard, reusing
  the same pane on every later click so the layout stays stable, and the section
  derivation walks up until it finds a section that actually exists.

**A required working sequence in `/bugs` and `/backlog`.** Both skills now claim
an item before touching anything, and the claim is **pushed before the work
starts**:

```
[refine first, if it isn't refined]   backlog only
claim      status + assignee -> the agent
commit and push                       ← the record alone
do the work
hand back  status + assignee -> the human, with a comment
commit and push
```

The stores are committed and shared, so until a claim is pushed nothing
anywhere says the item is taken — it sits in `open`, or in `refined`, which
explicitly means *anyone can pick this up*. The claim commit is the
announcement; a rejected push is how the agent finds out it lost the race,
rather than discovering it in a merge conflict hours later. Losing that race is
an instruction to stop, not an obstacle to route around.

**Refinement is a gate.** An unrefined epic or story is refined first, in its
own commit, pushed ahead of the claim — the bridge would allow `draft` →
`in-progress` (the ladder check tests membership, not adjacency), and nothing
but this rule stops it. A task has no `refined` state of its own, so the gate
falls on its **parent story**. Separating the refinement commit is the point:
an agent that writes its own acceptance criteria and then satisfies them has
marked its own homework, and pushing them first is the human's moment to
correct them.

The backlog skill also gained the `project` level it was missing — the fourth
prefix, its ladder, and how to treat one it meets in a tracker-written store.

**A drift guard for the skills.** The ASCII lifecycle diagrams in
`skills/backlog/SKILL.md` are parsed and compared to `LADDERS`, and the handback
states the sequence names are checked against the ladder each type actually
walks. The skills are what an agent reads *instead of* the code, so a drifted
diagram is not a stale doc — it is an agent confidently making transitions the
bridge rejects.

### Changed

- **One BugDesk directory, not a directory and a file that look like duplicates.**
  The shared collaborator roster moved from `bugdesk.json` at the project root
  into `.bugdesk/project.json`, alongside the per-user files — and the
  `.gitignore` in there now ignores everything *except* that one file, so the
  rule states which half is shared at the exact point where the difference has
  an effect. The split was always real (the team's list vs. your own identity,
  filters and layout); nothing on disk said so, and two things called
  `bugdesk.json` and `.bugdesk/` read as two names for one thing.

  **Nothing moves under anyone's feet**: a root `bugdesk.json` still wins when
  one exists, so an older repo keeps working untouched. `git mv bugdesk.json
  .bugdesk/project.json` adopts the new layout whenever you want it, and an
  existing `.bugdesk/.gitignore` gets the `!project.json` rule appended on
  startup — without that the moved roster would be written, look fine locally,
  and silently never reach anyone else's checkout, which is the one failure a
  shared file cannot report.

- **The board's columns are derived from a spec** rather than from a header
  array, a row array and hardcoded column indices in `renderCell`. Three
  hand-kept-in-step lists are fine only while the column list is fixed, and it
  no longer is — one conditional column is how a status pill ends up painted
  over an assignee.
- **The hierarchy rules are one definition.** `parentTypesFor` / `childTypesFor`
  moved to `backlog_data.js` beside the store they describe, and the flat
  `parentOptions` list they superseded is gone rather than left to drift. The
  picker, the New item form and the item page all read the same pair, and a test
  asserts the two are exact mirrors.
- **Rendered markdown matches the fields, not the document.** Descriptions and
  comments inherited the 12px body size while every label and input beside them
  is 11px, so free text read as the headline of a form it is one section of.
  Headings inside a body are now relative, and the composer is set to the same
  size, so what you type and what you get are the same text.

### Fixed

- **"Change your name" did not take effect.** Reported as "this feature has not
  been developed properly yet", and that was fair — three faults stacked on one
  button, none of them on the server, which had been writing the profile
  correctly all along.

  The one with no floor to it: `bugdesk.humanName` in the browser's own storage
  **outranked the profile on disk**. So once anyone had typed a name into
  Settings › General › Authorship, every later change wrote the profile, updated
  the bridge and updated what the skills read — while the UI went on signing
  comments with the stale local value, through every reload, permanently, with
  nothing anywhere reporting a problem. Identity now has one source of truth:
  the profile, which is the copy other people's tools can also read. The stored
  value stays as the fallback for a run with no reachable bridge, and every
  confirmed change is mirrored into it so it cannot go stale again.

  The one that made it look broken: **nothing applied a confirmed change to the
  running page.** In particular the chip in the bottom-left corner — the thing
  the README calls the piece of state you most need to be able to check at a
  glance — was painted at boot from a snapshot nobody ever refreshed, so you
  changed your name and the corner still said the old one. A change now
  re-points the config every module reads, mirrors the Settings rows, and
  announces itself so the chip repaints.

  And the one that hid the reload offer: it was gated on the profile **slug**
  changing, which does not move when you fix the capitalisation of your own name
  or rename only the agent. It compares the names now.

- **`BUGDESK_HUMAN` / `BUGDESK_AGENT` no longer outrank the config file.** They
  seed an identity when there is none; they do not override one. With
  `BUGDESK_HUMAN` exported in a shell profile, "change your name" wrote a file
  the server then ignored on every boot, for ever — and there was no way out of
  it from inside the app. An environment variable is how a process is *started*;
  a config file is what the user *changed*, and the more recent, more deliberate
  statement has to be the one that counts.

  On a first run with no profile, `BUGDESK_HUMAN` now **writes** one and the
  first-run prompt stays suppressed, so a scripted deployment behaves exactly as
  before. Seeding deliberately does not write `active.json`, for the same reason
  `BUGDESK_USER` does not: one `BUGDESK_HUMAN=bob ./run.sh` must not silently
  repoint the checkout's default for everybody else. The one thing an env var
  could do that a file cannot — a different identity per process, for two people
  sharing one checkout — is what `BUGDESK_USER` is for, and that is unchanged.

  `envLocked` is gone from `GET /api/config` along with the branch below that
  reported it: there is no lock left to report, and a field describing one would
  only invite the dead end back.

- **The dialog claimed success when `BUGDESK_HUMAN` was set.** That variable
  outranked the profile on the server, so a name typed into the dialog was
  written to disk and then ignored on every boot — and the dialog said "Now
  &lt;old name&gt;" and moved on. It was first made honest about that, and then
  the precedence above removed the situation entirely; the branch is gone.

- **The Parent picker's display was visibly larger than every control beside
  it.** It is an `<input>`, and an input does not inherit the page font — it
  takes the browser's own (~13.3px Arial). Now matched to the choice control it
  sits next to.
- The item picker could not reach a type this deployment does not offer, so a
  `PROJ-` record written by a tracker was permanently unfindable in a plain
  backlog — not merely unfiltered, but with no control to say so. Its chips now
  cover every type actually in the store.

## 0.2.0 — 2026-09-10

BugDesk stops being a single-user bug tracker. It now knows who is using it,
and it tracks the work you *meant* to do alongside the work that broke.

### Added

**Live updates.** The bridge watches both store directories and pushes changes
to every open browser over Server-Sent Events (`GET /api/events`). Before this
the UI only knew the store as it was at page load, so an agent could move a bug
to `testing` and the human would sit looking at `investigation` until they
happened to reload — and if they then saved, they silently overwrote the agent.

- Lists repaint on any change.
- The record you have open refreshes **silently when you have no unsaved
  edits** — the common case by a wide margin.
- When you *do* have unsaved edits, the page says the file changed and offers
  both choices: discard yours and reload, or keep yours and overwrite on save.
  Neither is safe to pick on the user's behalf.
- A deleted record is reported as such.
- **Your own saves never announce themselves.** Every BugDesk write also trips
  the watcher, so the bridge records the SHA-256 of what it wrote and treats a
  file still hashing to that value as its own echo. A timing window would have
  been the obvious fix and the wrong one — a slow disk makes it a race.
- Bursts coalesce over 250 ms (a `git pull` rewriting twenty files is one
  repaint), and the stream heartbeats every 25 s so proxies do not drop it.

**A shared collaborator roster.** `bugdesk.json`, beside the stores and
**committed**, lists everyone who can be assigned work here. It is the opposite
of the per-user profile: an assignee dropdown offering only "me and my agent"
cannot express "this is Alice's", which is most of what triage is.

- Every assignee picker and both filter catalogues read it.
- It maintains itself — setting your name adds you — and the `/bugs` and
  `/backlog` skills can add the people they find in the git history via
  `POST /api/project/collaborator`.
- Editable in **Settings › General › Authorship › Manage collaborators**.
- Each person's agent name is **derived** as `<name>_agent` rather than asked
  for. "What should my agent be called" is a question with no interesting
  answer, and two people whose agents both sign as `agent` cannot be told apart.

**Per-user identity.** The first time you open BugDesk it asks for your name,
once, and writes it to a git-ignored `.bugdesk/` directory beside the stores.
Everything in `bugs/` and `backlog/` is shared and committed — that is the
point — but your name, your saved filters and your window layout are not, so
several people can work one repo without overwriting each other on every pull.

- `.bugdesk/` writes its own `.gitignore` (`*`), so nothing there can be
  committed by accident and the surrounding project's `.gitignore` never needs
  an entry.
- `BUGDESK_USER=<name>` selects a profile for one process without repointing
  the checkout's default — two people can share a single checkout.
- `BUGDESK_HUMAN`/`BUGDESK_AGENT` still win, and suppress the prompt: an
  explicitly configured deployment is not "unconfigured".
- Who you are is shown in the bottom-left corner at all times. Clicking it
  opens Settings › General › Authorship, which now **writes through** to the
  profile — the UI and `GET /api/config` (what the skills read) can no longer
  disagree about your identity.
- `GET`/`POST /api/config/user`, `GET`/`POST /api/user/settings`.

**A backlog.** A second markdown store, `backlog/`, holding
`EPIC-`/`STORY-`/`TASK-NNNN.md`. Epics → stories → tasks, one shared id
sequence so `parent: 7` is unambiguous, and a `phase` milestone label carried
on epics that stories and tasks inherit.

- `## Acceptance criteria` as a first-class section — rendered as a **checklist
  you tick**, with add / rename / remove / reorder-free editing in place and the
  markdown editor one click away. `POST /api/backlog/{id}/criteria` applies one
  addressed operation to one line, so prose or sub-bullets the checklist never
  parsed survive a tick.
- Full CRUD over `/api/backlog`, with the listing returned in **tree order**
  (depth is a function of the whole store, so the bridge resolves it once
  rather than every client re-deriving it).
- Cycle and self-parent guards on re-parenting.
- Section-level patching: `description` and `acceptance` are editable through
  the API without touching frontmatter or the comment thread.
- A **Backlog** top-nav page: a foldable tree with guide lines, roll-up
  context rows, and per-item detail with children, ancestry and comments.
- `/backlog` and `/backlog refine` Claude Code skills
  (`skills/backlog/SKILL.md`, `skills/backlog/REFINEMENT.md`). The five
  refinement checks are defined once, in `REFINEMENT_RULES`, and the UI lists
  which ones a `draft` still fails rather than greying out a button.
- Seven example items, seeded by `--seed`.

**Hierarchy in the UI.**

- Fold/expand carets with tree guide rails; the fold state persists to your
  profile, and a folded row shows how much it hides.
- Filtered views keep the ancestors of every match as dimmed context, so a
  matching story never floats at the root with nothing saying what it belongs
  to — and an unparented story reads as a problem precisely because every
  other row sits under something.
- The tile breadcrumb *is* the ancestry:
  `Backlog › EPIC-0001 › STORY-0007 › TASK-0031`, each crumb navigable.
- The left rail's Backlog side lists phases → epics as a navigable tree;
  clicking an epic scopes the board to that whole work package.

**Filters for both stores.** The expression language, compiler, describer and
validator moved out of `filters.js` into a field-agnostic
`filter_engine.js`, so the backlog gets the same AND/OR clause editor, live
preview and saved filters the bug queue has — over its own field catalogue.
Two backlog-only fields make the tree queryable rather than merely scrollable:
`epic` (the owning epic at any depth) and `depth`.

**FlexDesk as a real dependency.** `package.json` pins `flexdesk@^0.2.0` and
`npm run sync:flexdesk` refreshes `ui/vendor/flexdesk/` from the installed
package, stamping a `VERSION` file. `npm run check:flexdesk` fails loudly when
the vendored copy has drifted — a stale vendor directory is otherwise
invisible, since the app boots perfectly well on last release's code.

### Changed

- **The top-nav chips read `BUGS` and `BACKLOG`.** They read `QUE` and `BKL`:
  FlexDesk renders a chip as `shortLabel || label`, and the taxonomy was
  setting three-letter abbreviations where the whole job of the strip is to say
  which store you are looking at.
- **A bug's `type: task` now displays as "Chore".** The word "task" belongs to
  the backlog (epic → story → task), and one word meaning two things across two
  stores is a real source of confusion. The stored value is unchanged, so no
  existing `BUG-*.md` was rewritten.
- **The backlog lifecycle varies by type.** The status vocabulary is shared;
  the ladder each type walks is not:
  ```
  EPIC    draft → refined → in-progress ────────────→ done
  STORY   draft → refined → in-progress → review → done
  TASK    draft ──────────→ in-progress ────────────→ done
  ```
  An epic is never *reviewed* — its stories are, one at a time. A task inherits
  its story's acceptance criteria, so it has nothing of its own to refine and
  nothing separate to review. The bridge rejects a status the type's ladder
  does not contain, and retyping an item onto a shorter ladder clamps its
  status **downward**: a story in `review` demoted to a task becomes
  `in-progress`, never `done`, because nobody decided it was done.
- **Saved filters are per user, and carry a scope.** They lived in a single
  shared `server/state/filters.json`; two people on one repo have different
  questions to ask of the same records. An existing file is folded into the
  profile of whoever upgrades and then renamed aside, so the next colleague to
  run BugDesk does not inherit a stranger's filters.
- The left panel serves both stores through one `panel:left` kind, and which
  rail you get **follows the top nav** — the same `activeTopNavKind(wm)` that
  decides which chip is lit. It has no switch of its own: a rail with its own
  tabs is a second, competing answer to a question the top bar has already
  answered, and the two can then disagree (BACKLOG lit above, bug filters
  below).
- Creating lives on the page, not in the rail — the rail navigates. The Backlog
  page files **epic, story and task**; the Bugs page files a **bug**, both next
  to "Save as filter". "New epic" is gone from the rail.
- **One "New item" dialog spans both stores.** Its Type select carries
  Bug · Regression · Chore (→ the bug store) and Epic · Story · Task (→ the
  backlog), so picking the type picks the store. The top bar's separate "New
  Bug" button is gone: two per-store buttons asked the user to choose a store
  before saying what they were filing, and the store is a property of the
  thing. Opened with no preselection the dialog is titled "New item"; opened
  from a typed button it is titled for that type.
- `--seed` seeds each store independently: a repo that already tracks bugs but
  has no backlog still gets seeded backlog examples.
- `server/Program.cs` split into `Markdown.cs`, `Bug.cs`, `BacklogItem.cs` and
  `UserConfig.cs`.

### Fixed

- **Changing the Type on the New item page did not change the fields.** They
  were correctly marked `hidden`, and stayed on screen: the `hidden` attribute
  carries only the UA stylesheet's `display: none`, which `.td-field { display:
  grid }` beats. Hiding a row now also sets an inline style, which wins over any
  sheet — `setRowVisible` in `select_field.js`, used everywhere a row is
  toggled.
- **Clicking a backlog filter switched to the bug view.** Both rails mount into
  the same panel body, and the bugs rail's delegated listeners stayed attached
  when the backlog rail replaced its content. Both stores have a builtin keyed
  `active`, so clicking the backlog's "In progress" also fired the bug handler,
  which resolved `active` against the *bug* builtins and navigated to Queues.
  The handlers are guarded on which rail is showing, and removed on teardown.

- **The top-nav chip stopped highlighting.** `install.js` called
  `activeTopNavKind(wm)` without importing it — an edit whose import half never
  landed. Every sync threw a `ReferenceError`, so no chip ever lit.
- **Backlog item pages threw on render.** `parentOptions` moved out with the
  create form and the item page's Parent select still called it. It now lives in
  `backlog_data.js`, where both the item page and the New item dialog read one
  definition.
- **References rendered blue-on-blue.** `main_new.css` styles bare `button` with
  a solid accent fill; `.bd-item__ref` set a link colour but no background, so
  every epic/story reference on the item page was blue text on a blue button.
- **The Inspector was empty and silent.** It only ever read the bug store, so on
  the Backlog page — or on a project that files feature work before it has bugs
  — it rendered a header and nothing else. It now follows the top nav, shows
  backlog assignees when you are in the backlog, and says which of "no records"
  or "no assignees" it means.
- **"Change your name" did nothing visible.** It routed to the Settings page,
  opened in the *primary* tile — from a focused side tile the change happened
  somewhere the user was not looking. It is a dialog now, as its ellipsis
  promised, and the bottom-bar chip opens the same one.
- **One parent control, used everywhere.** The search picker was only on the
  New item page; the item detail page still had a plain dropdown. Re-parenting
  is the same act whether the item exists yet or not, so there is now one
  implementation (`attachParentPicker`) on both, with a clear button.
- **Children › Add existing** attaches an item you search for, preselected to
  the types that belong under this one (an epic offers stories, a story offers
  tasks) and excluding this item's own descendants, which would make a cycle.
  The separate **New** button still files a fresh child.
- **Assignee is searchable, and learns.** Naming somebody who is not on the
  roster adds them to it. The alternative is an assignee that exists in one file
  and nowhere else — no other picker offers it, no "On them" filter matches it,
  and the Inspector shows a name with no row.
- **Parent is a search, not a combobox.** A datalist matches on the literal
  prefix of the option text, so finding "Auth rewrite" meant typing the
  reference you opened the control to look up. The field is now a read-only
  display plus a magnifying glass that opens a real search dialog — filter by
  type (preselected to what can legally hold the item), type any part of a
  reference or title, arrow keys and Enter to pick. The field then shows
  `EPIC-0001 — Auth rewrite`. `openForm` gained a `picker` field type for it.
- **New item is a page, not a modal.** Filing something is not a two-second
  confirmation: you write a description, paste a screenshot into it, go and look
  the parent up, come back. A modal traps focus, cannot sit open beside the
  thing you are describing, and cannot be resized to fit a paragraph. It is now
  a content kind that opens in a tab, with the same markdown editor (and
  paste-a-screenshot support) the bug mask uses, and every field the records
  actually have — subsystem, phase, labels and estimate included.
- **Choice fields are BugDesk's own control, not `<select>`.** The browser draws
  its own, so it ignores the app's tokens, cannot carry an icon per option and
  cannot be typed into. All three matter here: Type wants a glyph, Assignee
  wants to mark which entries are agents, and Phase is a vocabulary you extend
  by typing a name that does not exist yet.
- **Phase is a searchable combo that accepts new values**, on the New item page
  and on the item page, where it was a plain text input.
- **Search covers both stores.** It searched bugs only, so the story you filed
  ten minutes ago was unfindable — and there is no reason to have to remember
  which store a thing went into before you can look for it. Results carry a
  Store column and open in whichever page their own store uses. Status and Type
  still narrow to bugs, since the backlog has neither.
- The top menu's File (New…, Open Project…, Save, Save All, Exit) and Edit
  entries are gone. BugDesk has no project to open and nothing to save — the
  store is a directory of markdown files, written the moment an edit is made —
  and a Save that does nothing is worse than no Save, because it implies the
  rest of the app might not have saved.
- **The New item form now follows the Type select.** A bug is asked for a
  severity; a story for a parent and an estimate; an epic for the phase its
  descendants inherit. It used to show every field of both stores at once,
  under headings reading "If it is a bug" — which a "New epic" dialog has no
  business asking. `openForm` gained an `onFieldChange` hook for this; the
  fields are built once and irrelevant rows hidden, because rebuilding on every
  change would discard whatever had already been typed.
- Copy that explained the implementation rather than the control has been
  removed from tooltips, hints and the first-run screen.
- `page_stubs.js` referenced an `_esc` it never defined — pre-existing, and it
  threw on every `window-placeholder` render (any tile promoted to a window).
- Removed an `if (false)` block in `app_bootstrap.js`, dead since TicketDesk
  dropped the Ecosim workspace.
- **A combobox with `create: true` threw** "onCreate is not a function" and
  blamed the user for typing their own name. That spelling now means "pick one
  of these, or type anything", which is what every caller meant by it, and the
  hint no longer promises to create something that is not being created.
- The per-page create buttons are all secondary. Story was primary while Epic
  and Task were not, implying a precedence between them that does not exist.

- **Tile layouts never persisted.** `workspace_state_read`/`_write` fell
  through to the permissive `/api/{**rest}` catch-all, which answers a *read*
  with `{ok:true}` — so the window manager received that object where a saved
  layout should have been, and every tile arrangement was lost on reload. Both
  are now implemented, per user.
- Frontmatter values containing `$1` were corrupted on write:
  `Regex.Replace` was given the new value as a replacement *pattern*, so a
  capture-group reference in a title expanded instead of being stored.
- Empty frontmatter values wrote a trailing space (`phase: `), showing up as a
  diff nobody authored.
- A backlog item's type could not be changed: `BacklogItem.Parse` treats the
  filename as authoritative, so writing `type:` alone was a no-op that looked
  like it worked. The file is renamed now.

### Tooling

- `scripts/test-dom.mjs` — component tests in jsdom. The bugs that have cost
  most here were not logic errors: a control that rendered but did nothing, a
  row that never appeared, a handler on the wrong element. None are visible to a
  test over a pure function, and without a browser they were invisible full
  stop. It asserts structure and behaviour only; jsdom has no layout, so it can
  verify that a row carries the inline style that hides it but never that it
  looks right.

- `npm test` — the module-graph check, eslint, and 42 unit tests over the filter
  engine, the tree builder, the lifecycle ladders and the top-nav derivation.
- `scripts/check-graph.mjs` verifies every import resolves and every named
  import is really exported. eslint's `no-undef` catches the opposite mistake —
  a name used with **no** import at all — which the graph check cannot see
  because there is nothing to resolve. That is the bug that broke the top-nav
  highlight, and the reason the linter was added.

### Notes

- `flexdesk@0.2.0` was published to npm. Its `dist/` is byte-identical to
  0.1.0 — the release exists so consumers can pin a version they can also
  `npm install`, rather than hand-copying `dist/` out of a git checkout.
- A latent bug remains in pre-existing code and was deliberately left alone:
  roughly eight call sites use `eventBus.off(name, handler)`, but
  `EventBus.off` takes the handle returned by `on()`. Those unsubscribes are
  no-ops and leak listeners. New code uses the correct form.

## 0.1.0

Initial import. A local, markdown-backed bug tracker: `BUG-NNNN.md` files, a
C# bridge serving a tiling FlexDesk UI over them, a filter rail with a visual
expression editor, and the `/bugs` Claude Code skill.
