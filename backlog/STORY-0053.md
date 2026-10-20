---
id: 53
type: story
title: "Embed BugDesk's dashboards and section homes"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, embedding, dashboards]
links: []
created: 2026-10-20
updated: 2026-10-20T15:20Z
---

## Description

An embedded copy (`js/ticketdesk/embed.js`, STORY-0052) registers the lists, the ticket form, the backlog pages and the rail, but not the dashboards or the section homes (`bugs-home`, `backlog-home`, `dashboards`). Their kinds are listed in `embedKinds()` so taxonomy pointers resolve, but no content is registered, so a host has to re-point them itself (AI Desk does, for the section crumbs). `dashboards/sources.js` still reads `window.__BUGDESK_TRACKER_CONFIG__`, and its change events are not scoped to the copy's prefix.

Embedding them would let a host such as AI Desk (`../aidesk`) show a project's dashboards and section homes as BugDesk shows them, under the copy's own prefix and API.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T15:20Z · norman_agent

Filed as a follow-up from STORY-0052 (embedding BugDesk), found while AI Desk phase 1 consumed the embed. Left draft for norman to refine.
