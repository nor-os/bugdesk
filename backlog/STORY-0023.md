---
id: 23
type: story
title: "Upgrade BugDesk to FlexDesk 0.9.1"
status: review
parent: 12
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk]
links: [blocks 8, blocks 18, blocks 7, blocks 9]
created: 2026-10-11
updated: 2026-10-12T13:04Z
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

- [x] BugDesk vendors FlexDesk 0.9.1 (was 0.7.0, see the comment of 2026-10-12): `ui/vendor/flexdesk/VERSION` says so, `package.json` asks for `^0.9.1`, and `npm run check:flexdesk` passes
- [x] The bug queue, backlog board, tracker, record pages, search, settings and help work as before, checked in headless Edge on real BugDesk windows
- [x] Every 0.5.0–0.7.0 change that alters something BugDesk relies on is adapted in BugDesk, and listed in BugDesk's CHANGELOG
- [x] `@flexdesk/flow` and `@flexdesk/host` can be imported by BugDesk code
- [x] BugDesk's DOM, UI and tracker test suites pass, with no test deleted just to make them pass

## History

- 2026-10-11 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-11T13:39Z · norman_agent

Filed and refined at your request: 5 criteria, 5 points, under EPIC-0012. It
blocks STORY-0008, STORY-0018, STORY-0007 and STORY-0009, which all build on
0.7.0.

### 2026-10-12T13:04Z · norman_agent (status: in-progress -> review)

Done in d80d596, against **FlexDesk 0.9.1** instead of 0.7.0, because you asked
for the newest release. I changed the title and the first criterion to match;
otherwise the criteria are as written.

- **Vendored:** `flexdesk@^0.9.1` in package.json, `VERSION` says 0.9.1, and
  `sync-flexdesk.mjs --check` passes. I ran the script directly, since
  `npm run` cannot run under WSL here.
- **New entry points:** `@flexdesk/flow` and `@flexdesk/canvas` are now in the
  import map, beside `@flexdesk/host`, and in the graph check. Both test suites'
  alias shims create them as well.
- **0.4.6–0.9.1 changes:** I read every release note. All of them are opt-in, or
  touch code BugDesk doesn't use: DataTable options, `createCommandPalette`
  (BugDesk's Ctrl+K palette is its own), `tabLayout`. 0.4.7's content-first
  `navigateBack` changes nothing, because no BugDesk page returns a
  `navigateBack`. No BugDesk code needed adapting; the CHANGELOG entry says so.
- **Checked in headless Edge** on a scratch copy of the store: the bug queue
  (5 rows, right-click menu, "5 of 5 open bugs shown"), a bug page, the
  backlog board (22 items), an item page, New item, the tracker dashboard,
  settings, help, bug search, Enter into a bug and Backspace back, Ctrl+K
  finding BUG-0011. Also TicketDesk (`BUGDESK_MODE=tracker`): dashboard and
  settings. No console errors anywhere.
- **Suites:** graph OK, eslint 0 errors, UI 218/218, tracker 34/34, DOM
  140/140.

One fix along the way: my BUG-0011 change had broken a tracker test. Its stub
`document` handed the same node to every `createElement`, so the picker's new
window chrome overwrote the picker body. The stub now keeps the first node it
creates. No test was deleted.
