---
id: 22
type: story
title: "Retire BugDesk's modal fork for FlexDesk's"
status: refined
parent: 12
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk, tech-debt]
links: []
created: 2026-10-06
updated: 2026-10-06T01:56Z
---

## Description

`ui/js/ui/components/modal.js` is BugDesk's copy of FlexDesk's `modal.js`
(625 lines against 718 upstream; about 400 changed lines between them). It
provides the prompt and confirm dialogs used by settings, collaborators,
first run, the project switcher and the bug moves. As with STORY-0008: move
whatever BugDesk's copy has that FlexDesk lacks into FlexDesk, switch over, and
delete the copy.

## Acceptance criteria

- [ ] Every dialog BugDesk opens through `modal.js` (settings, collaborators, first run, project switcher, the bug-move messages) works as before, on FlexDesk's `modal.js`
- [ ] Whatever BugDesk's copy has that FlexDesk lacks is added to FlexDesk with a test there, and released
- [ ] `ui/js/ui/components/modal.js` is gone, and no BugDesk file imports it
- [ ] BugDesk's DOM and UI test suites pass, with no test deleted just to make them pass

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 4 criteria, 5 points, under EPIC-0012. I found this second fork while
checking the epic: about 400 lines differ from FlexDesk's copy. The estimate is
rough until the diff has been sorted into "BugDesk-only" and "FlexDesk moved on".
