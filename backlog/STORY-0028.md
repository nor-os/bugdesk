---
id: 28
type: story
title: "Manage flows on their own, and pick them from a move or an action"
status: review
parent: 17
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: workflow
labels: [workflow, settings]
links: [relates-to STORY-0018, relates-to STORY-0007]
created: 2026-10-14
updated: 2026-10-14T08:21Z
---

## Description

Today a flow belongs to one move or action and is edited only from its row in
Edit workflow. Flows should be things of their own, managed in Settings under
a separate **Flows** entry in the settings sidebar, and a move or an action
should refer to one by name, found by searching, while still being able to
create a new one on the spot.

Reported with it: clicking "Add a step" in the flow editor opens the step menu
BEHIND the flow window. That is FlexDesk's: its flow popovers sit below managed
windows (FlexDesk BUG-0002, `../FlexDesk/bugs/BUG-0002.md`). BugDesk's part is
taking the fixed release.

## Acceptance criteria

- [x] Settings has a **Flows** entry in its sidebar; it opens a list of the project's flows (name, store, steps, where each is used) to add, rename, edit and remove
- [x] A flow in use cannot be removed until nothing refers to it, and the list says what uses it
- [x] In Edit workflow, a move's or an action's flow is chosen from a searchable list of the store's flows, with "New flow" to make one there and then, and an edit button for the chosen one
- [x] A flow used by a move cannot move to a status (only an action may), and a flow is checked against the fields of every table that uses it; saving refuses with the problem named
- [x] Existing flows stored inside a move or action keep working, and become named flows the first time the workflow is saved
- [x] The flow editor's window is titled "Flow — <flow name>"
- [x] "Add a step" opens its menu in front of the flow editor

## History

- 2026-10-14 · norman_agent · status: draft -> in-progress
- 2026-10-14 · norman_agent · assignee: -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman
- 2026-10-14 · norman_agent · status: review -> in-progress
- 2026-10-14 · norman_agent · assignee: norman -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T07:01Z · norman_agent (status: in-progress -> review)

Built in f98edbf, with the FlexDesk 0.11.1 bump in f51f868. All seven criteria
are met.

- **Settings › Flows:** a new sidebar category whose *Manage flows…* row
  opens the flows list.
  - Each row shows its name (editable), what it's for (Bugs or Backlog), its
    steps, and what uses it. There's a search box and a "New bugs flow" /
    "New backlog flow" button.
  - The remove "×" is disabled while something uses the flow; its tooltip
    says what.
- **Edit workflow:** each move's and action's Flow cell is a searchable picker
  of that store's flows, plus *New flow…*. Typing a name that isn't a flow
  offers *New flow "…"*. The pencil beside it opens the chosen flow.
- **Flow window:** titled *Flow — <name>*, with a Name field above the steps
  that retitles the window as you type. When the flow is shared, the footer
  says how many other rows use it.
- **Stored as:** `workflow.flows` = `[{id, label, store, flow}]`. A row's
  `flow` is now the flow's id. A graph stored inside a row the old way still
  runs; both editors lift it into a named flow, named after the row, and the
  next save stores it the new way.
- **Server checks**, verified against a scratch server:
  - a missing flow
  - a flow for the other store
  - duplicate or malformed ids
  - a flow that moves to a status used by a move (only an action may)
  - each flow against the fields of every table that uses it
- **"Add a step" behind the window:** that was FlexDesk BUG-0002
  (`../FlexDesk/bugs/BUG-0002.md`), released in flexdesk 0.11.1 and vendored
  here. In Edge, before the fix the step menu opened at z-index 200 under the
  window; now it opens at 7100, in front.
- **Checked in Edge on a scratch store:**
  - the Flows category and list, with three lifted flows
  - "Flow — Hand to testing" as the window title
  - typing "Triage" in a row's picker, making the flow, renaming it to
    "Triage it", and saving
  - `project.json` afterwards held the named flows and the rows' ids
- **Tests:** DOM 176 (two new ones for flowGraph, liftInlineFlows, flowUses
  and newFlowId), UI 218, tracker 34; import graph OK; lint has no errors.
- **Placement:** you chose the Settings sidebar over a nav entry inside Edit
  workflow.
- **To see it:** restart your BugDesk on 8766 (the server changed) and reload.

### 2026-10-14T08:08Z · norman_agent (status: review -> in-progress)

Review feedback from norman: in Settings › Flows the flows should be managed on the page itself, without managed windows. Taking it back: the Flows page will list the flows and edit the selected one in place (name, steps, remove, new), with one Save for the lot. Edit workflow's pencil keeps its window, since that already lives in one.

### 2026-10-14T08:19Z · norman_agent (status: in-progress -> review)

Done: Settings › Flows now manages the flows on the page itself, with no windows (commit d604638 on main).

- The list is on the left, with search, *New bugs flow* / *New backlog flow*, each flow's store, steps and how many rows use it. The selected flow's name and steps are edited on the right in the outline editor, with *Remove* (disabled while something uses it; the tooltip says what) and a line naming its users.
- One *Save* writes them all; *Discard changes* goes back. "Unsaved changes" shows meanwhile, and unsaved edits are still there when you come back to the page (unless the workflow was saved elsewhere meanwhile, which the page then says). Problems from the checks or the server are listed above the split, with a link to the flow, and marked on the flow in the list.
- Searching Settings for it offers *Go to Flows*.
- Edit workflow's pencil still opens the flow in a window, since that page is itself a window. Both use the same editor (mountFlowEditor).

Checked in Edge on a scratch store: list, select, rename, add-a-step menu on top, new flow, remove, save (project.json written), leave and come back with changes kept, and search. No managed window opens. Suites: DOM 176 passed plus 1 failing, "right-click a board cell and filter the board by it", which fails the same way on a clean checkout of main before this commit; UI 218, tracker 34, check-graph OK, eslint 0 errors.

### 2026-10-14T08:21Z · norman_agent

Correction to the handback: the board right-click test is not failing. It broke only while FlexDesk 0.12.0 was vendored but not yet committed (the new checkbox column), and the STORY-0029 commit 6eb86c9 fixed it. On main at ba5370b, test-dom is 177 passed, 0 failed.
