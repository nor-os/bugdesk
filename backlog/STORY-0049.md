---
id: 49
type: story
title: "Warn when a store has no git repository or no remote"
status: draft
parent: 19
phase:
assignee:
reporter: norman
due:
points:
subsystem: settings
labels: []
links: []
created: 2026-10-16
updated: 2026-10-16T06:30Z
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

_(not refined yet)_

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request ("is the tracker generally tracked in git? do we get a warning if no git repo has been initialized or has no remotes?"). The answer to both is in the description: no, and only passively.
