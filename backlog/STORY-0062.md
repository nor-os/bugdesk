---
id: 62
type: story
title: "The top bar matches EcoSim's and EcoAgent's: FlexDesk's hamburger, palette after the toggles"
status: review
parent:
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: ui
labels: [top-bar, flexdesk]
links: []
created: 2026-10-30
updated: 2026-10-30T11:45Z
---

## Description

norman, 2026-10-27: "../bugdesk ../EcoSim and ../EcoAgent all have slightly different top bars. These should be somehow standardized. EcoSim: I like the fact, that it has an icon, I like min/max/close buttons. EcoAgent: I like the hamburger-menu instead of the "File..." menu of EcoSim … Flexdesk should support for example to switch between hamburger menu and the "File.." menu." norman, 2026-10-30: "do bugdesk and hamburger menu as well".

EcoSim (STORY-0124) and EcoAgent (STORY-0064) moved to FlexDesk 0.17.18's menu bar drawn as a hamburger (FlexDesk STORY-0133). BugDesk had its own hamburger over hidden Help-dropdown markup, on FlexDesk 0.16.1.

## Acceptance criteria

- [x] BugDesk on flexdesk ^0.17.18, vendored (`sync-flexdesk.mjs --check` passes); the full `npm test` set passes
- [x] The menu is FlexDesk's hamburger (`createMenuBar`, `style: 'hamburger'`) at the top bar's left, before the brand: BugDesk (Settings, Team…, Change your name…) and Help (Help Topics, Keyboard shortcuts, About); the home-grown hamburger and the hidden Help dropdown are gone
- [x] The right reads BugDesk's actions (New Item, Search), the panel toggles, the palette button, then FlexDesk's window controls on a frameless window, as in EcoSim and EcoAgent
- [x] The left and right panel toggles show their own side's glyph
- [x] A dashboard tile's settings dialog shows its display settings on FlexDesk 0.17 (schema `key` / `description`)
- [ ] The brand keeps BugDesk's wordmark beside the icon (EcoSim and EcoAgent show the icon alone): norman to say whether it stays

## History

- 2026-10-30 · norman_agent · created (in-progress)
- 2026-10-30 · norman_agent · status: in-progress -> review
- 2026-10-30 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-30T11:45Z · norman_agent (status: in-progress -> review)

The upgrade from 0.16.1 broke six dashboard tests, all one cause: FlexDesk 0.17.0 renamed a tile config schema field's `name`/`help` to `key`/`description`, so BugDesk's tile settings dialog drew no display fields (title, unit, chart type…). tile_editor.js reads both now. No removed FlexDesk export is used.

Checked on Node 22 (jsdom 29 needs ≥20): check-graph, eslint (0 errors), test-ui 225, tracker 35, dashboards 60, dom 221 (3 new: the bar's order, the toggle glyphs, the hamburger's menus), dashboards-dom 58, dashboards-tracker 14, example 8, tracker-off 17, embed 16.

Also run for real (`run.sh` on scratch stores, headless Chromium over CDP): the hamburger opens, BugDesk › Settings / Team… / Change your name… fly out, no console errors. Seen there: a toast draws over an open menu. That is FlexDesk's (its menu bar's menus sit under the toast layer), filed there as BUG-0054.

The brand is left as it was (icon and wordmark in the product's own face), the one difference from EcoSim and EcoAgent; the last criterion asks whether to drop it.
