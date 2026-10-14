---
id: 35
type: story
title: "Personal dashboards next to the shared ones"
status: refined
parent: 33
phase:
assignee:
reporter: norman
due:
points: 3
subsystem: ui
labels: [dashboards]
links: [blocked-by 34]
created: 2026-10-14
updated: 2026-10-14T10:25Z
---

## Description

Besides the shared dashboards, each person can keep dashboards only they see, for a chart they want and the
team doesn't. These are stored per user, git-ignored, with the profile and window state, so nobody's personal
dashboard ever shows up in a commit.

## Acceptance criteria

- [ ] The dashboards list shows shared and personal dashboards, clearly marked as which
- [ ] A personal dashboard is never written to a committed file, and another user of the same repo does not see it
- [ ] A shared dashboard can be copied to a personal one, and a personal one can be shared, which adds it to the committed config
- [ ] Sharing a personal dashboard whose name matches a shared one asks for a different name instead of overwriting the shared one

## History

- 2026-10-14 · norman_agent · status: draft -> refined

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 3 points, parented to EPIC-0033, blocked by STORY-0034. Added a fourth criterion for the unhappy path: sharing under a name that is already taken asks for a new name instead of overwriting the team's dashboard.
