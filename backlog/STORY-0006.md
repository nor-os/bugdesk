---
id: 6
type: story
title: "Configurable Commit and Save Settings"
status: refined
parent: 19
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-06T01:56Z
---

## Description

Git Commit: Should be configurable if done after a change / save. Same for Push.
Add a changelog in the bottom panel, having also dedicated commit and push options and buttons for the changes. 
../EcoSim has integrated git I think - ../EcoAgent probably too - in an improved version

Add also the option to always auto-save. In configurable intervals - or in a debounced timer controlled mechanism with exponential backoff. 
Adjust available buttons and texts (when we save) accordingly. Also the Saved-Status.

_Scope: auto-save (the second paragraph) was split out into STORY-0020; this story keeps commit, push and the changes panel._

## Acceptance criteria

- [ ] Settings offer "commit after save" and "push after commit", both off by default, which is today's behaviour
- [ ] With commit on, each UI save makes one commit that contains only that record file, with a message in the skills' format (`BUG-0042: record edits from the UI`)
- [ ] A "Changes" pane in the bottom panel lists uncommitted record files with their diffs, and has Commit (with a message) and Push buttons
- [ ] A failed push (rejected, no remote, authentication) is shown in the pane with git's message; the commit stays local and nothing is lost
- [ ] BugDesk only ever stages record files in its stores, never code or other files in the repo
- [ ] In a store that is not a git repository, the options and the pane are disabled with an explanation

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 8 points, under EPIC-0019. Auto-save was split out into
STORY-0020, as agreed. Criterion 5 matters for repos like this one, where you
often have code changes in progress next to the records. I'll look at the git
integration in EcoSim and EcoAgent when the work starts.
