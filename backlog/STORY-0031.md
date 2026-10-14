---
id: 31
type: story
title: "BugDesk alerts run on FlexDesk's shared tab host, alert log, pane and bell"
status: in-progress
parent: 12
phase:
assignee: norman_agent
reporter: norman
points: 5
subsystem: ui
labels: [alerts, flexdesk]
links: []
created: 2026-10-14
updated: 2026-10-14T17:42Z
---

## Description

FlexDesk EPIC-0017 (`../FlexDesk/backlog/EPIC-0017.md`) moves bugdesk's bottom-panel tab strip
(`ui/js/ticketdesk/pages.js:2306-2390`), alert log and Alerts pane (`ui/js/ticketdesk/alerts.js:39-178`, `223-413`)
into FlexDesk so Tables can use them too (Tables EPIC-0292). bugdesk then uses FlexDesk's versions and keeps only
its own parts: the alert rules, their evaluation and the rules editor, plugged in as the pane's optional rules
column and the log's local source.

## Acceptance criteria

- [ ] The Alerts and Changes tabs, badges and remembered tab work as before, on FlexDesk's tab host
- [ ] The Alerts tab looks and behaves as before (chips, filter, days, unread, Open/Dismiss, rules column, still matches)
- [ ] The status-bar bell shows the unread count and opens the Alerts tab
- [ ] The copies in pages.js and alerts.js are removed; the rules engine and editor remain

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee:  -> norman_agent

## Comments

### 2026-10-14T09:50Z · norman_agent

Refined: 4 acceptance criteria, 5 points, parented to 12. Filed from the product owner's 2026-10-14 vision (notifications only from workflows; a notification area with history, shared through FlexDesk).

### 2026-10-14T17:42Z · norman_agent

Taking this on (session tables-5d), on top of 91d7c7b, which committed the bottom-panel Alerts/Changes work an earlier session left uncommitted. Plan: the panel on FlexDesk's createBottomPanelTabs; the Alerts tab is mountAlertsPane over one createAlertLog whose source merges this copy's log and the tracker copy's; the bell reads that log. alerts.js keeps the rules, their checking, the saved log and the editor.
