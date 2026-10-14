---
id: 32
type: story
title: "Settings sorted by who a change affects: You, and This project"
status: refined
parent: 19
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: settings
labels: [settings]
links: [relates-to STORY-0030]
created: 2026-10-14
updated: 2026-10-14T09:52Z
---

## Description

norman: "I think the structure of our settings pages currently does not make sense."

Today the sidebar is General, Workflow and Windows. General is FlexDesk's category ("Workspace behavior and notifications") and holds everything else: your name and agent name (your profile), Collaborators (shared bugdesk.json), Record types, Numbering, Saving and git and Alerts (shared project.json), and Ctrl-click (this browser). Nothing says which rows change things for the whole team. "Saving and git" looks personal and is shared, auto-save included. Workflow is edited on the page; the four other project editors open windows. Collaborators sits under Authorship beside your own name. Windows is one checkbox. Numbering is a separate editor, though a prefix belongs to a record type.

Sort the sidebar by who a change affects, then by topic, and edit everything on the page:

- You: Profile (your name, agent name); Behaviour (Ctrl-click, animate minimize, auto-save).
- This project: Record types (with numbering), Workflow, Team, Alerts, Git.

## Acceptance criteria

- [ ] The Settings sidebar shows two headed sections, "You" (Profile, Behaviour) and "This project" (Record types, Workflow, Team, Alerts, Git). General and Windows are gone.
- [ ] Every page under "This project" says that changes there apply to everyone who pulls the repo.
- [ ] Record types, Team, Alerts and Git are edited on the Settings page itself; no row opens a window.
- [ ] Prefixes are set on the Record types page, next to each type; padding, first number and increment once per store there. The separate Numbering editor is gone, and the server still refuses a bad or shared prefix, with the message shown on the page.
- [ ] Auto-save (off, at an interval, or after typing, and its seconds) is set per person under Behaviour. Commit after save and push after commit stay shared under Git. Until someone sets their own auto-save, the project's existing value applies to them.
- [ ] Filtering the Settings sidebar still finds every row by its name.

## History

- 2026-10-14 · norman_agent · status: draft -> refined

## Comments
