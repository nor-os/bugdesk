---
id: 8
type: story
title: "Retire BugDesk's DataTable fork for FlexDesk's"
status: draft
parent:
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, tech-debt]
links: [relates-to BUG-0013]
created: 2026-10-05
updated: 2026-10-05T19:41Z
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

_(not refined yet)_
