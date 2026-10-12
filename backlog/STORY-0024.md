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
updated: 2026-10-12T13:16Z
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

- [ ] In settings, per record type, a project can add, rename, reorder and remove custom statuses, each with a category: active, waiting or finished
- [ ] Built-in statuses cannot be removed, and a custom status cannot take a built-in's name
- [ ] A custom status shows wherever statuses do: the record page, the status filter, the status column, sorting (by its position in the list) and the backlog board
- [ ] Its category decides what it counts as: a finished status leaves the default open queues and stops overdue highlighting, and a waiting one stays in them
- [ ] A record can be set to a custom status from its page, and once STORY-0018 is in, configured moves can target it
- [ ] Removing a custom status that records still hold is refused, with the number of records holding it
- [ ] A record file holding a status that is no longer configured opens normally, with the value marked unknown and left in the file unchanged
- [ ] The /bugs and /backlog skills tell agents to read custom statuses from `project.json` and to treat a finished one as terminal
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
