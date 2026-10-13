---
id: 6
type: story
title: "Configurable Commit and Save Settings"
status: review
parent: 19
phase:
assignee: norman
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-13T04:31Z
---

## Description

Git Commit: Should be configurable if done after a change / save. Same for Push.
Add a changelog in the bottom panel, having also dedicated commit and push options and buttons for the changes. 
../EcoSim has integrated git I think - ../EcoAgent probably too - in an improved version

Add also the option to always auto-save. In configurable intervals - or in a debounced timer controlled mechanism with exponential backoff. 
Adjust available buttons and texts (when we save) accordingly. Also the Saved-Status.

_Scope: auto-save (the second paragraph) was split out into STORY-0020; this story keeps commit, push and the changes panel._

## Acceptance criteria

- [x] Settings offer "commit after save" and "push after commit", both off by default, which is today's behaviour
- [x] With commit on, each UI save makes one commit that contains only that record file, with a message in the skills' format (`BUG-0042: record edits from the UI`)
- [x] A "Changes" pane in the bottom panel lists uncommitted record files with their diffs, and has Commit (with a message) and Push buttons
- [x] A failed push (rejected, no remote, authentication) is shown in the pane with git's message; the commit stays local and nothing is lost
- [x] BugDesk only ever stages record files in its stores, never code or other files in the repo
- [x] In a store that is not a git repository, the options and the pane are disabled with an explanation

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-13 · norman_agent · status: refined -> in-progress
- 2026-10-13 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 8 points, under EPIC-0019. Auto-save was split out into
STORY-0020, as agreed. Criterion 5 matters for repos like this one, where you
often have code changes in progress next to the records. I'll look at the git
integration in EcoSim and EcoAgent when the work starts.

### 2026-10-13T04:31Z · norman_agent (status: in-progress -> review)

Built in b8e299f and 58e748d. All six criteria are met.

- **Settings:** Settings › General › Project › **Saving and git…**, and the
  same two switches at the top of the Changes pane: *Commit after save* and
  *Push after commit*. Both are off by default, which is today's behaviour.
  They are stored as `git` in `.bugdesk/project.json`.
- **One commit per save:** with commit on, each save in BugDesk makes one
  commit with only that record file, by path, as
  `BUG-0042: record edits from the UI`. With push on, it is pushed after.
- **The Changes tab:** bottom panel › **Changes** shows the branch and how
  many commits are not pushed, the uncommitted record files (new / modified /
  deleted), a file's diff, a message box, **Commit** and **Push**.
- **A failed push** (rejected, no remote, no credentials) is shown in the pane
  with git's own message, and the commit stays local. Git never prompts for
  credentials, so a push can't hang.
- **Only record files:** BugDesk only stages record files in its own stores,
  and the bridge refuses any other path.
- **Not a git repository:** the pane says so, and the switches and buttons are
  off.

Checked on a scratch git repo with a bare remote, in Edge and by API:
- With both switches on, saving BUG-0011 made "BUG-0011: record edits from the
  UI" and pushed it. An uncommitted `code.txt` and `.bugdesk/project.json`
  were left alone.
- Commit from the pane worked.
- With the remote pointed nowhere, Push showed "failed — the commit is still
  here" and git's message.

A non-git scratch store reports disabled. DOM 160/160, UI 218/218,
tracker 34/34.

STORY-0020 (auto-save) will pass "don't commit yet" through the same
`WriteRecord(…, commit:)` switch, so it commits once the record is left.
