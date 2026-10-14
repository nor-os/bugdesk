---
id: 44
type: story
title: "Settings opens in a large modal dialog, like Help, instead of a tab"
status: refined
parent: 19
phase:
assignee:
reporter: norman
due:
points: 2
subsystem: settings
labels: []
links: []
created: 2026-10-14
updated: 2026-10-14T18:38Z
---

## Description

Settings opens as a tab in the main tile, so it takes the place of whatever you
were working on and stays among your tabs afterwards. Help opens as a modal over
the workspace and is gone when you close it. Settings should behave like Help,
in a larger dialog because its pages (Record types, Workflow, Team) are wider
than a help article.

## Acceptance criteria

- [ ] The menu's Settings entry opens Settings in a modal dialog over the workspace, and no tab is added to any tile
- [ ] The dialog is larger than Help: up to 1280×860, never more than about 92% of the window, and it can be maximised
- [ ] Every button that sends you to a Settings page (the snooze notice's "Record types", say) opens the dialog on that page; with the dialog already open it switches to that page instead of opening a second dialog
- [ ] Esc, the close button and a click on the backdrop close it, and the next time it opens it starts fresh
- [ ] Every Settings page works in the dialog as it did in the tab: search, the sidebar, the project editors' Save / Discard, and the reload hint
- [ ] A layout saved with a Settings tab in it still opens (the tab still shows Settings)

## History

- 2026-10-14 · norman_agent · status: draft -> refined

## Comments

### 2026-10-14T18:38Z · norman_agent

Filed at norman's request: "settings should (like help) pop up in a modal (but
larger than help)".

### 2026-10-14T18:38Z · norman_agent

Refined: 6 acceptance criteria, 2 points, under EPIC-0019. The dialog is
FlexDesk's `openModal` (maximizable), with the same Settings page mounted inside
it, so nothing about the pages changes. The `settings` content kind stays
registered, so a desktop layout saved with a Settings tab still opens.
