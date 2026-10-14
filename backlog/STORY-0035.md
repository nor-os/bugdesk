---
id: 35
type: story
title: "Personal dashboards next to the shared ones"
status: draft
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
updated: 2026-10-14T10:21Z
---

## Description

Besides the shared dashboards, each person can keep dashboards only they see, for a chart they want and the
team doesn't. These are stored per user, git-ignored, with the profile and window state, so nobody's personal
dashboard ever shows up in a commit.

## Acceptance criteria

- [ ] The dashboards list shows shared and personal dashboards, clearly marked as which
- [ ] A personal dashboard is never written to a committed file, and another user of the same repo does not see it
- [ ] A shared dashboard can be copied to a personal one, and a personal one can be shared, which adds it to the committed config

## History

## Comments
