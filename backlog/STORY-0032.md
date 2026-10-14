---
id: 32
type: story
title: "Settings sorted by who a change affects: You, and This project"
status: review
parent: 19
phase:
assignee: norman
reporter: norman
due:
points: 8
subsystem: settings
labels: [settings]
links: [relates-to STORY-0030]
created: 2026-10-14
updated: 2026-10-14T10:26Z
---

## Description

norman: "I think the structure of our settings pages currently does not make sense."

Today the sidebar is General, Workflow and Windows. General is FlexDesk's category ("Workspace behavior and notifications") and holds everything else: your name and agent name (your profile), Collaborators (shared bugdesk.json), Record types, Numbering, Saving and git and Alerts (shared project.json), and Ctrl-click (this browser). Nothing says which rows change things for the whole team. "Saving and git" looks personal and is shared, auto-save included. Workflow is edited on the page; the four other project editors open windows. Collaborators sits under Authorship beside your own name. Windows is one checkbox. Numbering is a separate editor, though a prefix belongs to a record type.

Sort the sidebar by who a change affects, then by topic, and edit everything on the page:

- You: Profile (your name, agent name); Behaviour (Ctrl-click, animate minimize, auto-save).
- This project: Record types (with numbering), Workflow, Team, Alerts, Git.

## Acceptance criteria

- [x] The Settings sidebar shows two headed sections, "You" (Profile, Behaviour) and "This project" (Record types, Workflow, Team, Alerts, Git). General and Windows are gone.
- [x] Every page under "This project" says that changes there apply to everyone who pulls the repo.
- [x] Record types, Team, Alerts and Git are edited on the Settings page itself; no row opens a window.
- [x] Prefixes are set on the Record types page, next to each type; padding, first number and increment once per store there. The separate Numbering editor is gone, and the server still refuses a bad or shared prefix, with the message shown on the page.
- [x] Auto-save (off or after typing, and its seconds) is set per person under Behaviour. Commit after save and push after commit stay shared under Git. Until someone sets their own auto-save, the project's existing value applies to them.
- [x] Filtering the Settings sidebar still finds every row by its name.

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T10:26Z · norman_agent

Built in 06280ca (pushed). All six criteria hold, checked in a real browser on a scratch server (CDP: sidebar, every page, saving and a refused prefix on Record types, auto-save picks) and in test-dom.

- **Sidebar**: You (Profile, Behaviour), then This project (Record types, Workflow, Team, Alerts, Git). General and Windows are gone: none of their rows are offered any more, so the page drops them. Settings opens on Profile, which has no Reset (blanking your name would switch profile).
- **Shared notice** under each project page's title. Workflow's also covers its Tracker section, which saves to the tracker's own project.json.
- **On the page**: Record types, Team, Alerts and Git each have Save and Discard (Git's two switches apply as you flip them, as in the Changes tab). The hamburger's Collaborators… and the Alerts tab's Edit rules still open windows on purpose, using the same editors: you ask those while looking at something else, and on a tracker page Edit rules edits the tracker's rules.
- **Numbering**: under each type in Record types (Name and number). A prefix sits beside its type; the bug types share one. Padding, first number and increment are shown per store. A refused prefix (e.g. used by two types) is shown on the page, and what you typed is kept. Unsaved Record types changes are still there when you come back. The snooze notice's Record types button opens this page on its store.
- **Auto-save** is now in your profile (`autosave`/`autosaveSeconds`), set under Behaviour. The options are the project's default (with its current value shown), Only when I press Save, or after typing N seconds. The server lays your choice over the project's value, so autosave.js is unchanged. The project's value stays in project.json as the fallback; the Git page no longer shows it, and saving the switches leaves it alone.

Decided along the way: someone edited this story's auto-save criterion to drop the interval mode (it's gone from the code) without committing; this commit includes that edit. The pageBus() helper from bugdesk-10's uncommitted work is in 06280ca, because every row mounts through it; they know.

