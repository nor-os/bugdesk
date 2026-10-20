---
id: 54
type: story
title: "A page-only css/embed.css bundle for hosts that embed BugDesk"
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

A host that embeds BugDesk (STORY-0052) has to load nine BugDesk stylesheets in order, and three of them are global, not scoped to BugDesk's pages: `css/tokens.css` and `css/bugdesk_controls.css` set `:root` tokens, and `css/tiling/tile.css` restyles every `.twm-*` tile in the host. The README now says so and advises loading them before the host's theme or leaving `tile.css` out; AI Desk leaves it out and has to copy a few glyph sizes back.

One `css/embed.css` with only the page rules, scoped so it cannot restyle the host's chrome, would replace the list and the caveats.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T15:20Z · norman_agent

Filed as a follow-up from STORY-0052 (embedding BugDesk), found while AI Desk phase 1 consumed the embed. Left draft for norman to refine.
