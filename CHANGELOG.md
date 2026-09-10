# Changelog

Notable changes to BugDesk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
