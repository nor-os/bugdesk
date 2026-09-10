# Changelog

Notable changes to BugDesk. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-09-10

BugDesk stops being a single-user bug tracker. It now knows who is using it,
and it tracks the work you *meant* to do alongside the work that broke.

### Added

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

- `## Acceptance criteria` as a first-class section, counted and rendered.
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
- Creating a backlog item lives on the backlog page, not in the rail — the rail
  navigates, and all three types (**epic, story and task**) are creatable
  there. "New epic" is gone from the rail.
- `--seed` seeds each store independently: a repo that already tracks bugs but
  has no backlog still gets seeded backlog examples.
- `server/Program.cs` split into `Markdown.cs`, `Bug.cs`, `BacklogItem.cs` and
  `UserConfig.cs`.

### Fixed

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
