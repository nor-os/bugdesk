---
id: 49
type: story
title: "Warn when a store has no git repository or no remote"
status: in-progress
parent: 19
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: settings
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T07:15Z
---

## Description

Records are only shared, and only backed up, once they are committed and
pushed. Today BugDesk says so only passively:

- **No repository:** the Changes pane and Settings › Git show "This store is not
  in a git repository, so there is nothing to commit or push"
  (`Program.cs:1859`, `changes_pane.js`), and the tracker's delete dialog warns
  that the file on disk is the only copy.
- **No remote:** nothing runs `git remote`. With no upstream, `Ahead()` returns
  -1, the pane shows "No remote branch, so nothing to push" and the push button
  is disabled. A repository with no remotes at all is treated the same as a
  branch without an upstream.
- There is no startup, first-run or alert-level warning in any mode.

**The tracker is deliberately outside any repo.** It lives in
`%APPDATA%\BugDesk\<slug>` (or `~/.bugdesk/<slug>`, `BUGDESK_TRACKER_HOME`, or
`[tracker] path` in `projects.toml`), and the code says so
(`Program.cs:1326`, `:1353`). So by default the tracker is not tracked in git
and has no history or backup unless the user runs `git init` there by hand.

Proposal: a visible, dismissable warning (alert or banner) when a store is not
in a repository, and a separate one when the repository has no remote. Also
offer to `git init` the tracker store and to add a remote.

Open questions for refinement:

- Should the tracker store be a git repository by default (`git init` on first
  run), so that the warning is the exception?
- Warn once per session, once per store, or until dismissed for good?
- Is "has no remote" different from "branch has no upstream"? Today they are
  the same.

## Acceptance criteria

- [x] When a store (the project's, or the tracker's) is not inside a git repository, BugDesk shows a sticky warning toast when it opens, naming the store and its folder, with "Initialize git" and "Don't warn again"
- [x] When a store is in a repository that has no remote at all, BugDesk shows a separate sticky warning toast, with "Add remote…" and "Don't warn again"; a repository that has a remote but whose branch has no upstream gets no toast and keeps the Changes pane's passive "No remote branch" line
- [x] BugDesk never runs `git init` by itself; "Initialize git" runs it once in the store's folder (the tracker's base folder; for a project, the folder its stores sit in), and the Changes pane then lists the store's records as new, ready to commit
- [x] "Add remote…" asks for a URL and adds it as `origin`; an empty URL, one with spaces or one starting with `-` is refused with a message and nothing changes; once added, the no-remote warning does not come back
- [x] "Don't warn again" hides that warning for that store and that person for good: it stays hidden across reloads and restarts, is saved in the person's own state (not project.json), and does not hide the other store's warning; × only closes the toast until BugDesk opens again
- [x] A dismissed warning comes back when the condition changes: when the store becomes fine, or moves to the other condition, the dismissal is cleared, so the next time it is not in a repository (or has no remote) it warns again
- [x] The Changes pane and Settings › Git offer the same "Initialize git" and "Add remote…" where they apply, and the pane says "No remote configured" rather than "No remote branch" when the repository has no remote
- [x] The in-app help, README and CHANGELOG describe the two warnings and what dismissing does

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request ("is the tracker generally tracked in git? do we get a warning if no git repo has been initialized or has no remotes?"). The answer to both is in the description: no, and only passively.

### 2026-10-17T06:20Z · norman_agent

Refined with norman's answers (2026-10-17) to the open questions:

- **git init by default?** No. The tracker is not initialized automatically; a
  visible, dismissable warning per store says it is not in a repository, with a
  one-click "Initialize git" for that store.
- **Once per session, per store, or for good?** Per store, until dismissed for
  good: the dismissal is personal state, and the warning comes back if the
  condition changes.
- **No remote vs no upstream?** Different. "No remote at all" gets its own
  warning with "Add remote…" (a URL prompt); "the branch has no upstream" keeps
  today's passive line in the Changes pane.
- The warnings use FlexDesk's notification system BugDesk already uses for
  alerts (STORY-0031): sticky toasts with actions.

8 criteria, 5 points, under EPIC-0019. Taking it on.

### 2026-10-17T07:05Z · norman_agent

Built on branch `ultra/track-B`, not yet integrated into main; it stays in progress until then.

- The bridge: `GET /api/git` now also returns `remotes` (by name) and `home` (where Initialize git would run `git init`), and finds a repository made since it last looked. New `POST /api/git/init` and `POST /api/git/remote {"url"}`, which adds `origin` and only to a repository with no remote. An empty URL, one with spaces and one starting with `-` are all refused with a 400. A just-initialized repository now reports its branch name and not `HEAD`.
- `ui/js/ticketdesk/git_warnings.js`: one sticky warning per store copy (the project, and on a project page the tracker too), on FlexDesk's NotificationCenter, the same one alert toasts use. "Don't warn again" saves the dismissed condition in `git-warnings.json` in the person's own state for that store. A dismissal is cleared as soon as the store is fine or in the other condition. A warning whose condition has gone is closed on screen.
- The Changes pane says "No remote configured" and offers Add remote… when there is no remote, and offers Initialize git outside a repository. Settings › Git offers the same two buttons. Help ("Editing records" › Not in git, or no remote), README and CHANGELOG are updated.

Checked on a scratch server with Edge over CDP: two projects (one outside git, one with a remote but no upstream), a tracker outside git, and two fresh projects. Every criterion was checked there. The tracker's Initialize git produced a repository, the Changes pane listed its 5 records as new, and the no-remote warning appeared. Add remote… refused `my repo.git` in the form, then added `origin`. Don't warn again held across a reload and wrote `{"dismissed":"no-repo"}` to `.bugdesk/state-norman/` (project.json unchanged). × came back on reopen. Removing the remote by hand brought the warning back. The upstream-less project showed no warning, just "No remote branch". New tests are in `scripts/test-dom.mjs` (6).

### 2026-10-17T07:15Z · norman_agent

Fixes after review:

- A repository that disappears while BugDesk runs (its `.git` removed or moved) is noticed: the store reports "not in a git repository" again and gets that warning, not a false "has no git remote". When git cannot list the remotes (it fails or times out), the bridge now says it does not know (`remotes: null`), and no warning is raised.
- On a project page, the Changes pane's Tracker group now says "No remote configured" with its own Add remote… when the tracker's repository has no remote. The bar still describes the project's repository.
- `POST /api/git/remote` with a body that is not JSON returns a 400 with a message, not a 500.
- Enter in the Add remote URL field already submits and runs the check. The review sent a keyDown with no text, which does not submit a form. Sent with Enter's text, `-bad` showed the inline error and a valid path added `origin`.

Checked on a scratch server with Edge over CDP: the tracker's Add remote… in the project page's pane, Enter in the URL field, and the tracker's `.git` removed while the server ran (both pages then warned "The tracker is not in a git repository"). One more test is in `scripts/test-dom.mjs`.
