---
id: 34
type: story
title: "Dashboards is a top-level section with shared, committed dashboards"
status: draft
parent: 33
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: ui
labels: [dashboards, flexdesk]
links: []
created: 2026-10-14
updated: 2026-10-14T10:21Z
---

## Description

Add a `dashboards` kind with `isTopNav` in `ui/js/tiling/kind_taxonomy.js`, placed next to Tracker, and give it a
content factory in `ui/js/tiling/install.js`. The page holds a list of the project's dashboards. Each dashboard
is a FlexDesk `TileGrid` in which tiles can be added, removed, moved, resized and configured.

Shared dashboards live in the committed project config: `project.json` under `dashboards`, read and written
through `ProjectConfig` like the schema and workflow. A change therefore shows in the Changes pane and is
committed like any other config edit. `.bugdesk/.gitignore` already tracks that file.

Wiring: map `@flexdesk/tiles` and `@flexdesk/charts` in the import map of `ui/index.html`, and vendor Plotly
under `ui/vendor/plotly/`, with its licence in THIRD_PARTY_LICENSES. Plotly loads only when a dashboard is
opened, not on startup.

## Acceptance criteria

- [ ] A Dashboards chip in the top bar of every project, bugs mode and tracker mode alike, opens the dashboards page
- [ ] A dashboard can be created, renamed and deleted, and its tiles added, removed, moved, resized and configured
- [ ] Shared dashboards are saved to the project's committed config; another checkout sees them after a pull, and an edit shows in the Changes pane
- [ ] Opening BugDesk without opening a dashboard does not load Plotly
- [ ] Dashboards follow the light/dark theme and the window manager's layout persistence like other pages

## History

## Comments
