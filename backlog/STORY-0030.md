---
id: 30
type: story
title: "One workflow: a record type's actions run flows, and a flow makes the move"
status: in-progress
parent: 17
phase:
assignee: norman_agent
reporter: norman
due:
points: 8
subsystem: workflow
labels: [workflow, settings]
links: [relates-to STORY-0028, relates-to STORY-0007, relates-to STORY-0029]
created: 2026-10-14
updated: 2026-10-14T10:04Z
---

## Description

norman, reviewing STORY-0028: "we need to merge workflow and flows. they should be the same thing. what currently is a move, needs to be a step in a flow ... on a ticket type and subtype, I add an action. that action links to a flow, the flow executes the move."

Today a record type has a move table (from, label, to, needs a message, flow) and, separately, custom actions; flows are something a move runs on the side. In one model, a record type has **actions**. Each action has a name, the statuses it is offered in, and the **flow** it runs, and the flow's *Change the status* step is the move. A flow says which records it is for: bugs, backlog or tracker, and which of their types.

## Acceptance criteria

- [x] Settings has one Workflow page, with no windows: record types on the left, the selected type's actions, and the selected action's flow edited in place. The flows list is part of the same page. The Edit workflow window is gone.
- [x] Every record type lists its actions, the built-in moves included as actions: "Close" on a Bug is one action, offered in open, investigation and testing, running the flow Close (ask for the message, change status to closed).
- [x] An action has a name, the statuses it is offered in (or any), and a flow picked from a searchable list of the flows available for that type, with New flow and typing a name to make one.
- [x] A flow has an availability setting: which records (bugs or backlog/tracker) and which of their types. A flow not available for a type cannot be picked there, and the server refuses it.
- [x] Records offer their type's actions for their status: ones that change the status where moves are offered today (Action buttons, right-click, mass Change status), the others as custom actions.
- [x] Only what differs from built-in is saved. Existing move tables and custom actions in project.json keep working and become actions the first time the workflow is saved.
- [x] A type's mass actions are configured on the same page.

## History

- 2026-10-14 · norman_agent · status: draft -> in-progress
- 2026-10-14 · norman_agent · assignee: norman -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman
- 2026-10-14 · norman_agent · status: review -> in-progress
- 2026-10-14 · norman_agent · assignee: norman -> norman_agent

## Comments

### 2026-10-14T09:34Z · norman_agent

Filed from norman's review of STORY-0028 and taking it on. norman chose one Workflow page: types, then actions, then the action's flow, with the flows list on the same page.

### 2026-10-14T10:01Z · norman_agent (status: in-progress -> review)

Built in 928b1db on main. Handing back to norman for review.

- **Settings › Workflow** is one page with no windows. Record types are on the left (Bugs: Bug, Regression, Chore; Backlog: Epic, Story, Task; a tracker's Project too), then the selected type's actions and its mass actions, then the selected action and its flow, edited in place. **Flows**, under the types, lists every flow with what runs it. The Edit workflow window, the separate Flows page and their settings rows are gone. Right-click an action (move up or down, duplicate, edit its flow, delete) or a flow (rename, duplicate, delete).
- **An action** has a name, *Offered in* (status chips, or any status) and *Runs* (a searchable picker of the flows available to that type, plus New flow and typing a name to make one). *Add action* gives a new action a flow of its own; while unsaved, its id and that flow follow its name.
- **A flow** says what it is for: *For* (Any record, Bugs or Backlog) and *Available to* (type chips; a type an action runs it from cannot be unticked). Its *Change the status* step is the move.
- **Built-in:** every type shows its built-in moves as actions ("Close" on a Bug: offered in open, investigation, blocked and testing; flow Close = ask for the close message, change status to closed). Same name but different steps are told apart by target ("Reopen (→ review)").
- **Saving** writes only the types that differ, as `workflow.types.<store>.<type>`. An untouched type stays on the built-in moves, or on an older move table or custom actions. Records read a type's own list: actions that change the status are its moves (Action buttons, right-click, mass Change status), and the rest are custom actions. The server checks the new key, a flow's types, and mass actions naming a type's actions.

Checked in Edge on a copy of the real project.json: the page opens with nothing to save. Renaming Story's Drop to Abandon wrote only `types.backlog.story` and its flows, and after a reload a draft story offers "Abandon". A new action on Task with its own flow saved as `ping-owner`, and the picker offers only flows available to Task. The real project's Blocked actions kept their older storage. Suites on a clean checkout of 928b1db: UI 221, DOM 185, check-graph OK. The working tree's DOM run (188) includes other sessions' uncommitted tests.

### 2026-10-14T10:04Z · norman_agent (status: review -> in-progress)

norman asked "what about tracker?". Inside BugDesk, the Tracker tab is a second store with its own project.json, and Settings › Workflow only edits the project's. Taking it back to put the tracker's types (Project, Epic, Story, Task) and its flows on the same page, saved to the tracker's own project.json.
