---
id: 55
type: story
title: "Read-only option in the embed contract for users without bugdesk:edit"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, embedding, permissions]
links: []
created: 2026-10-20
updated: 2026-10-20T15:20Z
---

## Description

AI Desk refuses writes through its proxy for a user without `bugdesk:edit` (403), but the embedded ticket form, backlog item, comment box and criteria checkboxes stay fully editable, so every attempt fails only on save. AI Desk STORY-0103 (`../aidesk/backlog/STORY-0103.md`) has a criterion for a read-only view that cannot be met without a BugDesk change.

Add an option to `createBugDeskEmbed` (e.g. `readOnly`, or a callback the copy asks) that renders the record pages read-only: no Save, no action buttons, no comment box, disabled checkboxes, no new-record buttons.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T15:20Z · norman_agent

Filed as a follow-up from STORY-0052 (embedding BugDesk), found while AI Desk phase 1 consumed the embed. Left draft for norman to refine.
