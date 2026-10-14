---
id: 26
type: story
title: "BugDesk uses the native host in the desktop app"
status: refined
parent: 21
phase:
assignee:
reporter: norman
due:
points: 3
subsystem: desktop
labels: [desktop]
links: [requires 25]
created: 2026-10-13
updated: 2026-10-14T14:31Z
---

## Description

With FlexDesk's Photino host (FlexDesk STORY-0015, `../FlexDesk/backlog/STORY-0015.md`), BugDesk asks the window for what a browser tab cannot give: its size and place remembered, and the native save dialog for exports. In a browser tab nothing changes (`NULL_HOST`).

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [ ] In the desktop app, exporting a table or chart to CSV/PNG opens the native Save dialog and writes the file where you chose; cancelling writes nothing and says nothing was saved
- [ ] The desktop window comes back at its last size, position and maximised state; if that position is on a monitor that is gone, it opens centred on the primary one
- [ ] FlexDesk draws no window buttons of its own in the desktop window (the native title bar is the only one)
- [ ] In a browser tab nothing changes: exports download as before, and no host error reaches the console

## History

- 2026-10-14 · norman_agent · status: draft -> refined

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 4 criteria, 3 points. Requires FlexDesk STORY-0015 (refined today,
`../FlexDesk/backlog/STORY-0015.md`) and a FlexDesk release carrying it; you
agreed to publish that when it is ready. The tile layout and table state keep
going through the server, as now, so the host's `state` stays BugDesk's.
