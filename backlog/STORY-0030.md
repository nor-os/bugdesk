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
updated: 2026-10-14T09:34Z
---

## Description

norman, reviewing STORY-0028: "we need to merge workflow and flows. they should be the same thing. what currently is a move, needs to be a step in a flow ... on a ticket type and subtype, I add an action. that action links to a flow, the flow executes the move."

Today a record type has a move table (from, label, to, needs a message, flow) and, separately, custom actions; flows are something a move runs on the side. In one model, a record type has **actions**. Each action has a name, the statuses it is offered in, and the **flow** it runs, and the flow's *Change the status* step is the move. A flow says which records it is for: bugs, backlog or tracker, and which of their types.

## Acceptance criteria

- [ ] Settings has one Workflow page, with no windows: record types on the left, the selected type's actions, and the selected action's flow edited in place. The flows list is part of the same page. The Edit workflow window is gone.
- [ ] Every record type lists its actions, the built-in moves included as actions: "Close" on a Bug is one action, offered in open, investigation and testing, running the flow Close (ask for the message, change status to closed).
- [ ] An action has a name, the statuses it is offered in (or any), and a flow picked from a searchable list of the flows available for that type, with New flow and typing a name to make one.
- [ ] A flow has an availability setting: which records (bugs or backlog/tracker) and which of their types. A flow not available for a type cannot be picked there, and the server refuses it.
- [ ] Records offer their type's actions for their status: ones that change the status where moves are offered today (Action buttons, right-click, mass Change status), the others as custom actions.
- [ ] Only what differs from built-in is saved. Existing move tables and custom actions in project.json keep working and become actions the first time the workflow is saved.
- [ ] A type's mass actions are configured on the same page.

## History

- 2026-10-14 · norman_agent · status: draft -> in-progress
- 2026-10-14 · norman_agent · assignee: norman -> norman_agent

## Comments

### 2026-10-14T09:34Z · norman_agent

Filed from norman's review of STORY-0028 and taking it on. norman chose one Workflow page: types, then actions, then the action's flow, with the flows list on the same page.
