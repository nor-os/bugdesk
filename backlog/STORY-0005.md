---
id: 5
type: story
title: "Alerts"
status: review
parent: 17
phase:
assignee: norman
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-13T05:07Z
---

## Description

Use SSE to send alerts for tickets. Alerts must be configurable on any attribute with the conditions we also allow for filters. Of course, this only works while bugdesk is active. 

Alerts should be shown where console currently is shown and optionally as toasts which optionally have to be closed with x -otherwise they would stack up to n toasts and the n+1 toasts just collapses to x alerts. 

We also need to differentiate between warnings, info and alert - but - I think we already have a good template for this in flexdesk? We're using it in Audit logs in ../Tables

## Acceptance criteria

- [x] Settings define alert rules: a condition (from the filter editor, over any field including custom ones), a level of info, warning or alert, and whether it also shows a toast
- [x] When a record starts matching a rule, because of a UI edit, an agent's file edit or a git pull, the open BugDesk shows the alert within 5 s via SSE, without a reload
- [x] Alerts appear in the bottom panel where the console is, with level, time, rule and a link that opens the record
- [x] Toasts are optional per rule; a sticky toast closes only with ×; beyond N open toasts (default 3) further ones collapse into one "+x more alerts" toast
- [x] A rule fires when a record starts to match, not again while it keeps matching; nothing fires for changes made while BugDesk was not running, and settings say so
- [x] It uses FlexDesk's `toast.js` and `notification_history.js` (as Tables' audit log does), without a BugDesk copy

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-13 · norman_agent · status: refined -> in-progress
- 2026-10-13 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: retyped from TASK-0005 to STORY-0005 (same id), 6 criteria, 8
points, under EPIC-0017. The levels and toasts reuse FlexDesk's components, as
your note about Tables' audit log suggests. Criterion 5 makes "only while
BugDesk is active" explicit, and keeps a record that stays matching from
alerting over and over.

### 2026-10-13T05:07Z · norman_agent (status: in-progress -> review)

Built in e446c17, on FlexDesk 0.11.0's toast collapse (FlexDesk STORY-0014).
All six criteria are met.

- **Rules:** Settings › General › Project › **Edit alerts…** Each rule has a
  name, a store, a level (info, warning or alert), Toast, Sticky, and a
  condition built in the filter editor (any field, custom ones included).
  Picking a condition there doesn't touch your saved filters. Stored as
  `alerts` in `.bugdesk/project.json`. The bridge checks each rule's shape.
- **Within seconds, no reload:** the rules are evaluated in the page after
  every store change. An agent's file edit or a `git pull` reaches the page
  over SSE, and this page's own saves are caught too.
- **The Alerts tab** (bottom panel) lists each alert with level icon, time,
  rule, and a link that opens the record.
- **Toasts:** optional per rule. A sticky one closes only with ×. Past 3, the
  rest wait behind one "+N more" toast. The bell in the bottom bar keeps them
  all, with a count.
- **Fires once per record:** a rule fires when a record STARTS to match, not
  again while it keeps matching. When BugDesk opens it takes today's matches
  as the baseline, so nothing fires for changes made while it was closed. The
  settings description and the rules editor say so.
- **FlexDesk's own pieces:** `NotificationCenter` (`overflow: 'collapse'`)
  and `NotificationHistory`, mounted once at boot; no BugDesk copy. As a side
  effect, BugDesk now shows the toasts it has always emitted ("Collaborators
  saved", …), which nothing was drawing before.

Checked in Edge on a scratch store, with a rule "severity is crash", level
alert, sticky toast:
- Changing BUG-0016's file by hand raised the toast.
- Saving #15 as crash from its page raised another.
- Four files flipping at once gave 3 toasts and "+1 more", 4 rows in the
  Alerts tab, and a bell badge of 4.
- The rules editor added a second rule through the filter editor's condition
  picker.

DOM 166/166, UI 218/218, tracker 34/34.
