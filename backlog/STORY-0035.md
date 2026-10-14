---
id: 35
type: story
title: "Personal dashboards next to the shared ones"
status: done
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: ui
labels: [dashboards]
links: [blocked-by 34]
created: 2026-10-14
updated: 2026-10-14T17:31Z
---

## Description

Besides the shared dashboards, each person can keep dashboards only they see, for a chart they want and the
team doesn't. These are stored per user, git-ignored, with the profile and window state, so nobody's personal
dashboard ever shows up in a commit.

## Acceptance criteria

- [x] The dashboards list shows shared and personal dashboards, clearly marked as which
- [x] A personal dashboard is never written to a committed file, and another user of the same repo does not see it
- [x] A shared dashboard can be copied to a personal one, and a personal one can be shared, which adds it to the committed config
- [x] Sharing a personal dashboard whose name matches a shared one asks for a different name instead of overwriting the shared one

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman
- 2026-10-14 · norman_agent · status: review -> done

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 3 points, parented to EPIC-0033, blocked by STORY-0034. Added a fourth criterion for the unhappy path: sharing under a name that is already taken asks for a new name instead of overwriting the team's dashboard.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All four criteria are ticked.

- The list has Shared and Personal sections, with an icon per row and a badge in the header.
- Personal dashboards are kept in the git-ignored `.bugdesk/state-<user>/dashboards.json`. Checked on a real instance with `git check-ignore`.
- Copy to personal and Share both work. Share asks for another name when a shared dashboard already has it, and always uses a new id, so it never overwrites one.

### 2026-10-14T17:31Z · norman_agent

Accepted by norman; closed with EPIC-0033.
