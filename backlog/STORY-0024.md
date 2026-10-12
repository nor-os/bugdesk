---
id: 24
type: story
title: "Custom statuses per record type"
status: in-progress
parent: 3
phase:
assignee: norman_agent
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: [blocks 7]
created: 2026-10-12
updated: 2026-10-12T13:40Z
---

## Description

The status lists are fixed today: open, investigation, testing and closed for
bugs, and each backlog type's ladder. A project should be able to add its own
statuses per record type, such as `blocked` on bugs, which STORY-0007's
"Blocked" action needs.

Each custom status belongs to a category (active, waiting or finished). The
category decides what the status means wherever BugDesk asks "is this still
open?": the default queues and counts, overdue highlighting, and what an agent
treats as finished. The built-in statuses stay, because the /bugs and /backlog
skills' claim and handback steps depend on them. Custom statuses are added
alongside them. Settings are stored in `.bugdesk/project.json`.

## Acceptance criteria

- [x] In settings, per record type, a project can add, rename, reorder and remove custom statuses, each with a category: active, waiting or finished
- [x] Built-in statuses cannot be removed, and a custom status cannot take a built-in's name
- [ ] A custom status shows wherever statuses do: the record page, the status filter, the status column, sorting (by its position in the list) and the backlog board
- [x] Its category decides what it counts as: a finished status leaves the default open queues and stops overdue highlighting, and a waiting one stays in them
- [x] A record can be set to a custom status from its page, and once STORY-0018 is in, configured moves can target it
- [x] Removing a custom status that records still hold is refused, with the number of records holding it
- [x] A record file holding a status that is no longer configured opens normally, with the value marked unknown and left in the file unchanged
- [x] The /bugs and /backlog skills tell agents to read custom statuses from `project.json` and to treat a finished one as terminal
- [ ] Example: bugs get `blocked` (category waiting), and STORY-0007's "Blocked" action moves a bug into it

## History

- 2026-10-12 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-12T09:06Z · norman_agent

Filed and refined at your request: 9 criteria, 8 points, under EPIC-0003. Two
decisions to check:
- The built-in statuses stay, because the skills' claim and handback depend on
  them.
- Each custom status gets a category (active, waiting or finished), so filters,
  counts, overdue highlighting and agents know whether it is still open, without
  a hard-coded list.

It blocks STORY-0007, whose "Blocked" example now uses a real status.

### 2026-10-12T13:40Z · norman_agent

Progress, in 04b5a11. Seven of nine criteria are met; the other two are open.

- **Settings › Record types:** per type, add, rename (the label), reorder and
  remove custom statuses. Each has a category (active, waiting, finished) and
  an optional "after", the status it sits after in the order.
- **Refused:** a built-in name, and removing a status records still hold.
  The refusal gives the count ("'blocked' is held by 1 bug record…"),
  checked by the bridge.
- **Where it shows:** the record page (as a move: "Move to Blocked", and
  "Back to Investigation" from it), the right-click menus, the status filter,
  its own view in the rail with a count, the board, and the chevrons (it
  stands where "after" puts it).
- **Category decides what it counts as:** a finished status leaves Active,
  "Needs my reply", the per-person counts and the backlog's open views like
  `closed` / `done`, and stops overdue. A waiting one stays in them.
- **Unknown status:** a status no longer configured opens normally, shown as
  written and marked, and is left in the file.
- **Skills:** a finished custom status is terminal for the agent.

Open:
- **Criterion 3, sorting by position.** The backlog tree sorts by it. The flat
  board and the bug queue still sort the Status column alphabetically. That
  needs FlexDesk's DataTable `sortValue`, which comes with STORY-0008.
- **Criterion 9, the example.** `blocked` on bugs together with STORY-0007's
  Blocked action.
