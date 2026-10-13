---
id: 8
type: story
title: "Retire BugDesk's DataTable fork for FlexDesk's"
status: review
parent: 12
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk, tech-debt]
links: [relates-to BUG-0013, requires 23]
created: 2026-10-05
updated: 2026-10-13T04:53Z
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

_Re-checked against FlexDesk 0.7.0 on 2026-10-11:_
- _covered upstream: sort returns to page 1 (`resetPageOnSort`), the row
  surviving a sort or refresh (`getRowKey`), and opening a row with modifier
  keys (`onRowActivate(idx, row, ev)` passes the event)_
- _partly covered: right-click menus. `onRowContextMenu` lets BugDesk draw its
  own menu, but there is no item-list API_
- _still missing: a hook for the record count, and remembering the page (with a
  `persistPage`-style opt-out); only sort and filters are remembered_

## Acceptance criteria

- [x] FlexDesk's own `DataTable` covers what is still missing (the record count, a remembered page with an opt-out, and the right-click menus BugDesk draws), each with a test in FlexDesk's suite
- [x] A FlexDesk release carrying them is published and vendored into BugDesk, with the npm publish approved by norman first
- [x] `ui/js/ui/components/data_table.js` is gone, and no BugDesk file imports it
- [x] On the bug queue, the backlog board and search results, the right-click menus, the record count in the status bar, and the Enter / Ctrl+Enter / Alt+T / Alt+N / Alt+Shift+H / Alt+Shift+V shortcuts behave as before the switch
- [x] The highlighted row stays on the same record through a sort, a refresh and a return to the view
- [x] BUG-0013 does not come back: sorting returns to page 1, a saved view reopens on its page, and the ad-hoc queue and search results always open on page 1
- [x] BugDesk's DOM and UI test suites pass, with no test deleted just to make them pass

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-05T20:26Z · norman_agent

Refined: 7 acceptance criteria, 8 points, parented to the new EPIC-0012 "Run
BugDesk on stock FlexDesk", as you picked. Fibonacci points are the scale from
here on; no item had an estimate before. I kept it as one story instead of
splitting off the upstream work, because the upstream features are only "done"
once BugDesk runs on them. The criteria include an explicit regression check for
BUG-0013, and they gate the npm publish on your go-ahead.

### 2026-10-11T13:39Z · norman_agent

Re-checked against FlexDesk 0.7.0 (see the note in the description). Three
of the five gaps are closed upstream, so criterion 1 now names only what is
left, and the estimate drops from 8 to 5. The other criteria are unchanged.
Requires STORY-0023.

### 2026-10-13T04:53Z · norman_agent (status: in-progress -> review)

Done in 293734b, on FlexDesk 0.11.0. All seven criteria are met.

- **FlexDesk side:** FlexDesk STORY-0010 (`../FlexDesk/backlog/STORY-0010.md`)
  added `contextMenuItems` / `onContextMenuAction`, `onRender` +
  `getDisplayedRows()`, `persistPage`, and `keyboardNav` + `onRowKeyDown`.
  Each has a FlexDesk test, and they ship in 0.11.0, which you approved and I
  published.
- **The copy is gone:** `ui/js/ui/components/data_table.js` is deleted, and
  with it the whole `ui/js/ui/components/` folder (EPIC-0012's first
  criterion). The queue, the board and search results build FlexDesk's table
  through `ticketdesk/bd_table.js`. That one adapter maps the options they
  were written against:
  - `rowKey` → `getRowKey`, and the selection is remembered by key across a
    return to the view.
  - `onRowOpen` → click (Ctrl/⌘ = modified), plus Enter, Ctrl+Enter, Alt+T,
    Alt+N, Alt+Shift+H and Alt+Shift+V on the focused table. These fall back
    to the row the keyboard was last on after a Ctrl-click deselects.
  - The menu callbacks' signatures, a seeded Pri column width, and
    `getSort()` for the tree.
- **Checked in Edge:**
  - Queue: right-click menu (moves, actions, open…), "10 of 10 open bugs
    shown", and Status sorted Open → Blocked → Testing → Closed.
  - Arrow down + Enter opened #100; Backspace returned with #100 still
    selected, and Alt+T opened it.
  - Board: tree sorted by status within each level, right-click with
    Mark refined / Drop, and "23 of 23 open items shown".
- **BUG-0013:** `resetPageOnSort` is on for every BugDesk list, so a sort
  starts on page 1. A saved view reopens on its page (`persistPage`), and the
  ad-hoc queue and search results don't (`persistPage: false`). Tests cover
  all three.
- **Tests:** DOM 164/164, UI 218/218, tracker 34/34. The fork's own DOM tests
  were ported to run against the adapter over FlexDesk's table; none was
  deleted. Two assertions changed with the API:
  - `getDisplayedRows()` now spans every page, so "which page" is read off the
    body.
  - Double-clicking a column edge now asserts FlexDesk's **fit to content**,
    where the fork un-pinned the width. That is a behaviour change, also noted
    in the CHANGELOG. Say if you want the old one back, and it goes into
    FlexDesk as an option.
