---
id: 8
type: story
title: "Retire BugDesk's DataTable fork for FlexDesk's"
status: refined
parent: 12
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: ui
labels: [flexdesk, tech-debt]
links: [relates-to BUG-0013]
created: 2026-10-05
updated: 2026-10-05T20:26Z
---

## Description

BugDesk ships its own copy of FlexDesk's table, `ui/js/ui/components/data_table.js`
(2,698 lines; FlexDesk's is 3,284 and has moved on since the copy split off).
Every table fix now has to be made twice: BUG-0013's "a sort goes back to the
first page" went into both, and the copies drift whenever somebody forgets.

The copy survives only because FlexDesk's `DataTable` lacks what BugDesk's
lists use. As of 2026-10-05, none of these exist upstream:

- `contextMenuItems` / `onContextMenuAction`: every right-click menu on the
  bug queue, the backlog board and search results
- `onRender` / `getDisplayedRows`: the record count in the status bar
- `rowKey`: the highlighted row and selection surviving a sort, a refresh
  and a return to the view
- `onRowOpen(idx, row, how)`: Enter / Ctrl+Enter / Alt+T / Alt+N /
  Alt+Shift+H / Alt+Shift+V
- the page you were on, persisted with the sort and filters, plus
  `persistPage: false` for keys shared by different row sets (BUG-0013)

Plan: add each feature to FlexDesk with a FlexDesk test, release FlexDesk
(publishing to npm needs the go-ahead), point BugDesk's tables at
`@flexdesk/widgets`' `DataTable`, and delete the copy.

## Acceptance criteria

- [ ] FlexDesk's own `DataTable` supports each of the five features above, and every one has a test in FlexDesk's suite
- [ ] A FlexDesk release carrying them is published and vendored into BugDesk, with the npm publish approved by norman first
- [ ] `ui/js/ui/components/data_table.js` is gone, and no BugDesk file imports it
- [ ] On the bug queue, the backlog board and search results, the right-click menus, the record count in the status bar, and the Enter / Ctrl+Enter / Alt+T / Alt+N / Alt+Shift+H / Alt+Shift+V shortcuts behave as before the switch
- [ ] The highlighted row stays on the same record through a sort, a refresh and a return to the view
- [ ] BUG-0013 does not come back: sorting returns to page 1, a saved view reopens on its page, and the ad-hoc queue and search results always open on page 1
- [ ] BugDesk's DOM and UI test suites pass, with no test deleted just to make them pass

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T20:26Z · norman_agent

Refined: 7 acceptance criteria, 8 points, parented to the new EPIC-0012 "Run
BugDesk on stock FlexDesk", as you picked. Fibonacci points are the scale from
here on; no item had an estimate before. I kept it as one story instead of
splitting off the upstream work, because the upstream features are only "done"
once BugDesk runs on them. The criteria include an explicit regression check for
BUG-0013, and they gate the npm publish on your go-ahead.
