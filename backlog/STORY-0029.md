---
id: 29
type: story
title: "Mass actions: select many records and change their assignee or status in one go, per type in Settings"
status: in-progress
parent: 17
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: workflow
labels: []
links: []
created: 2026-10-14
updated: 2026-10-14T06:29Z
---

## Description

Triage means moving a dozen bugs to one person, or closing twenty stale items
with the same reason. Today each one is opened, or right-clicked, and moved on
its own, and the message is typed twenty times.

Every list (the bug queue, the backlog board, search results) gets FlexDesk's
select mode (FlexDesk STORY-0016, `../FlexDesk/backlog/STORY-0016.md`) and,
while rows are ticked, a bar of **mass actions**. Which mass actions a type
offers is configured per store and type in `.bugdesk/project.json`
(`workflow.massActions`), edited in Settings › Workflow. With nothing
configured every type offers two:

1. **Change assignee** — one person, set on every selected record.
2. **Change status to…** — only the target statuses that EVERY selected record
   can move to from where it is now (the same moves its page and right-click
   menu offer, configured or built-in). A move that needs a message asks for it
   ONCE, and that message is saved on every record. A move with a flow asks its
   questions once too.

A project may also offer its custom actions (STORY-0007) as mass actions.

## Acceptance criteria

- [ ] The bug queue, the backlog board and the search results each have a select-mode toggle; while rows are ticked, a bar shows how many and the mass actions on offer
- [ ] "Change assignee" sets the one chosen person on every selected record
- [ ] "Change status to…" lists only targets every selected record can move to from its current status; a target any one of them cannot reach is not offered, and a move a type gates (refined, with unmet refinement checks) is not offered when any selected record fails the gate
- [ ] A move that needs a message asks once, and every moved record gets that message as its status comment; a move's flow asks its questions once and runs per record
- [ ] Afterwards a status line says how many records changed and names any that failed, and the list refreshes
- [ ] Settings › Workflow lets a project pick, per store and type, which mass actions are offered (assignee, status, and its custom actions); saved in `workflow.massActions` and checked by the bridge (an unknown entry or custom action is refused)
- [ ] With nothing configured every type offers Change assignee and Change status; a mass action is offered only when every selected record's type offers it
- [ ] Tests cover the intersection of moves, the once-only message and the config check; the existing suites pass

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee:  -> norman_agent

## Comments

### 2026-10-14T06:29Z · norman_agent

Filed, refined and taken on together, from the user's request in this session.
8 criteria, 5 points, under EPIC-0017. Needs FlexDesk STORY-0016 released
(flexdesk 0.12.0) first.
