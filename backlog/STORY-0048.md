---
id: 48
type: story
title: "Bugs and Backlog open on a home dashboard"
status: draft
parent: 45
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: []
links: [requires 47]
created: 2026-10-16
updated: 2026-10-16T06:30Z
---

## Description

Today the Bugs home is the queue table (`pages.js`, `mountQueues`), and the
Backlog home is the board (`mountBacklogBoard`). Each section should open on its
own home dashboard, a standard dashboard like the Tracker's (STORY-0047), with
the queue or board one click away in the rail.

Candidate default tiles:

- **Bugs:** open by severity, assigned to me or my agent, needs my reply,
  in testing, opened vs closed over time
- **Backlog:** in progress, ready (refined), in review, drafts waiting for
  refinement, progress per phase or epic

Open question: should the home dashboard replace the queue and board as the
landing page, or sit beside them as one more rail entry with a setting that
picks the landing page?

## Acceptance criteria

_(not refined yet)_

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. It reuses whatever tile types STORY-0047 adds.
