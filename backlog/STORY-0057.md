---
id: 57
type: story
title: "embed.backlog(): a backlog tree API for embedding hosts"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, embedding]
links: []
created: 2026-10-20
updated: 2026-10-20T15:20Z
---

## Description

The embed (STORY-0052) gives a host the bug filters with counts (`filters()`) but no backlog tree. AI Desk's Backlog mode (AI Desk STORY-0110, `../aidesk/backlog/STORY-0110.md`) draws the epic › story › task tree by reading BugDesk's REST call `GET <root>api/backlog` through `embed.apiUrl`, and re-reads it on `backlog:changed`.

An `embed.backlog()` (the tree in order, with status and points, from the copy's already-loaded store) plus the existing change event would let hosts drop the REST read.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T15:20Z · norman_agent

Filed as a follow-up from STORY-0052 (embedding BugDesk), found while AI Desk phase 1 consumed the embed. Left draft for norman to refine.
