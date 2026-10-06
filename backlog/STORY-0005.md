---
id: 5
type: story
title: "Alerts"
status: refined
parent: 17
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-06T01:56Z
---

## Description

Use SSE to send alerts for tickets. Alerts must be configurable on any attribute with the conditions we also allow for filters. Of course, this only works while bugdesk is active. 

Alerts should be shown where console currently is shown and optionally as toasts which optionally have to be closed with x -otherwise they would stack up to n toasts and the n+1 toasts just collapses to x alerts. 

We also need to differentiate between warnings, info and alert - but - I think we already have a good template for this in flexdesk? We're using it in Audit logs in ../Tables

## Acceptance criteria

- [ ] Settings define alert rules: a condition (from the filter editor, over any field including custom ones), a level of info, warning or alert, and whether it also shows a toast
- [ ] When a record starts matching a rule, because of a UI edit, an agent's file edit or a git pull, the open BugDesk shows the alert within 5 s via SSE, without a reload
- [ ] Alerts appear in the bottom panel where the console is, with level, time, rule and a link that opens the record
- [ ] Toasts are optional per rule; a sticky toast closes only with ×; beyond N open toasts (default 3) further ones collapse into one "+x more alerts" toast
- [ ] A rule fires when a record starts to match, not again while it keeps matching; nothing fires for changes made while BugDesk was not running, and settings say so
- [ ] It uses FlexDesk's `toast.js` and `notification_history.js` (as Tables' audit log does), without a BugDesk copy

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: retyped from TASK-0005 to STORY-0005 (same id), 6 criteria, 8
points, under EPIC-0017. The levels and toasts reuse FlexDesk's components, as
your note about Tables' audit log suggests. Criterion 5 makes "only while
BugDesk is active" explicit, and keeps a record that stays matching from
alerting over and over.
