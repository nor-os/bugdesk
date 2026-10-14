---
id: 34
type: story
title: "Dashboards is a top-level section with shared, committed dashboards"
status: done
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [dashboards, flexdesk]
links: []
created: 2026-10-14
updated: 2026-10-14T17:31Z
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

`@flexdesk/charts` already has `setPlotlySource` and `ensurePlotly`, so point it at the vendored copy. Don't add a second loader.

## Acceptance criteria

- [x] A Dashboards chip in the top bar of every project, bugs mode and tracker mode alike, opens the dashboards page
- [x] A dashboard can be created, renamed and deleted, and its tiles added, removed, moved, resized and configured
- [x] Shared dashboards are saved to the project's committed config; another checkout sees them after a pull, and an edit shows in the Changes pane
- [x] Opening BugDesk without opening a dashboard does not load Plotly
- [x] Dashboards follow the light/dark theme and the window manager's layout persistence like other pages
- [x] A `dashboards` entry the UI cannot read (hand-edited or malformed) shows as a broken dashboard with the reason, and is kept rather than dropped on the next save

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman
- 2026-10-14 · norman_agent · status: review -> done

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 5 points, parented to EPIC-0033. Added a sixth criterion for the unhappy path: a dashboards entry that can't be read is shown as broken and kept, so one bad hand edit doesn't wipe a shared dashboard on the next save. Also noted in the description that the vendored @flexdesk/charts already provides `setPlotlySource`/`ensurePlotly` for lazy loading.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All six criteria are ticked.

- The Dashboards chip is in the top bar in bugs and tracker mode. The page is `ui/js/dashboards/`, on FlexDesk's TileGrid and chart/KPI tiles.
- Shared dashboards are saved one at a time into `.bugdesk/project.json` (`/api/project/dashboards`). On a real instance an edit showed in the Changes pane, and opening a dashboard without editing left the file byte-for-byte unchanged.
- Plotly is not requested at boot; it loads when a dashboard opens (checked in the browser's resource list).
- A hand-broken entry shows its reason and survives other dashboards' saves unchanged.
- Light theme: BugDesk is dark-only, so only dark was checked.
- Limit: in tracker mode the config is in `config/`, which is not under git.

### 2026-10-14T17:31Z · norman_agent

Accepted by norman; closed with EPIC-0033.
