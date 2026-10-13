---
id: 22
type: story
title: "Retire BugDesk's modal fork for FlexDesk's"
status: review
parent: 12
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk, tech-debt]
links: []
created: 2026-10-06
updated: 2026-10-13T04:43Z
---

## Description

`ui/js/ui/components/modal.js` is BugDesk's copy of FlexDesk's `modal.js`
(625 lines against 718 upstream; about 400 changed lines between them). It
provides the prompt and confirm dialogs used by settings, collaborators,
first run, the project switcher and the bug moves. As with STORY-0008: move
whatever BugDesk's copy has that FlexDesk lacks into FlexDesk, switch over, and
delete the copy.

## Acceptance criteria

- [x] Every dialog BugDesk opens through `modal.js` (settings, collaborators, first run, project switcher, the bug-move messages) works as before, on FlexDesk's `modal.js`
- [x] Whatever BugDesk's copy has that FlexDesk lacks is added to FlexDesk with a test there, and released
- [x] `ui/js/ui/components/modal.js` is gone, and no BugDesk file imports it
- [x] BugDesk's DOM and UI test suites pass, with no test deleted just to make them pass

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 4 criteria, 5 points, under EPIC-0012. I found this second fork while
checking the epic: about 400 lines differ from FlexDesk's copy. The estimate is
rough until the diff has been sorted into "BugDesk-only" and "FlexDesk moved on".

### 2026-10-13T04:43Z · norman_agent (status: in-progress -> review)

Done in 20b105e, on FlexDesk 0.11.0 (20b105e). All four
criteria are met.

- **FlexDesk side:** what BugDesk's copy had and FlexDesk lacked went into
  FlexDesk STORY-0011 (`../FlexDesk/backlog/STORY-0011.md`): `onFieldChange`
  with `setVisible/get/set`, the `picker` field, `create: true` on a select,
  and hidden rows that stay hidden. It has a 48-assertion suite there and is
  released in 0.11.0.
- **BugDesk side:** every dialog now imports `openForm` / `openConfirm` /
  `openModal` from `@flexdesk/widgets`: settings, collaborators, first run,
  the project switcher, the bug-move messages, and the newer conversion,
  numbering and "Saving and git" dialogs. `ui/js/ui/components/modal.js` is
  deleted, and nothing imports it.
- **Checked in Edge:** collaborators, numbering, saving-and-git, a move's
  Close message (cancelled → "Status unchanged."), and convert. Each opened as
  a FlexDesk window with its fields and buttons, and closed with Escape,
  leaving no window behind. The move message dialog renders with FlexDesk's
  styling.
- **Tests:** DOM 164/164, UI 218/218, tracker 34/34. The collaborators test now
  reads FlexDesk's `twm-` action classes; no test was removed.
