---
id: 23
type: story
title: "Upgrade BugDesk to FlexDesk 0.7.0"
status: in-progress
parent: 12
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk]
links: [blocks 8, blocks 18, blocks 7, blocks 9]
created: 2026-10-11
updated: 2026-10-12T12:56Z
---

## Description

BugDesk vendors FlexDesk 0.4.5 (`package.json`: `"flexdesk": "^0.4.5"`), while
FlexDesk is at 0.7.0. The releases in between bring what several stories now
build on:
- `@flexdesk/flow` (0.6.0), the flow editors, for STORY-0018 and STORY-0007
- `@flexdesk/host`, the host port, for STORY-0009
- the DataTable options from 0.5.0 and 0.7.0, which shrink STORY-0008

This story only does the upgrade. It adopts no new feature beyond what the
upgrade forces.

## Acceptance criteria

- [ ] BugDesk vendors FlexDesk 0.7.0: `ui/vendor/flexdesk/VERSION` says so, `package.json` asks for `^0.7.0`, and `npm run check:flexdesk` passes
- [ ] The bug queue, backlog board, tracker, record pages, search, settings and help work as before, checked in headless Edge on real BugDesk windows
- [ ] Every 0.5.0–0.7.0 change that alters something BugDesk relies on is adapted in BugDesk, and listed in BugDesk's CHANGELOG
- [ ] `@flexdesk/flow` and `@flexdesk/host` can be imported by BugDesk code
- [ ] BugDesk's DOM, UI and tracker test suites pass, with no test deleted just to make them pass

## History

- 2026-10-11 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-11T13:39Z · norman_agent

Filed and refined at your request: 5 criteria, 5 points, under EPIC-0012. It
blocks STORY-0008, STORY-0018, STORY-0007 and STORY-0009, which all build on
0.7.0.
