---
id: 31
type: story
title: "BugDesk alerts run on FlexDesk's shared tab host, alert log, pane and bell"
status: review
parent: 12
phase:
assignee: norman
reporter: norman
points: 5
subsystem: ui
labels: [alerts, flexdesk]
links: []
created: 2026-10-14
updated: 2026-10-14T18:02Z
---

## Description

FlexDesk EPIC-0017 (`../FlexDesk/backlog/EPIC-0017.md`) moves bugdesk's bottom-panel tab strip
(`ui/js/ticketdesk/pages.js:2306-2390`), alert log and Alerts pane (`ui/js/ticketdesk/alerts.js:39-178`, `223-413`)
into FlexDesk so Tables can use them too (Tables EPIC-0292). bugdesk then uses FlexDesk's versions and keeps only
its own parts: the alert rules, their evaluation and the rules editor, plugged in as the pane's optional rules
column and the log's local source.

## Acceptance criteria

- [x] The Alerts and Changes tabs, badges and remembered tab work as before, on FlexDesk's tab host
- [x] The Alerts tab looks and behaves as before (chips, filter, days, unread, Open/Dismiss, rules column, still matches)
- [x] The status-bar bell shows the unread count and opens the Alerts tab
- [x] The copies in pages.js and alerts.js are removed; the rules engine and editor remain

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee:  -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T09:50Z · norman_agent

Refined: 4 acceptance criteria, 5 points, parented to 12. Filed from the product owner's 2026-10-14 vision (notifications only from workflows; a notification area with history, shared through FlexDesk).

### 2026-10-14T17:42Z · norman_agent

Taking this on (session tables-5d), on top of 91d7c7b, which committed the bottom-panel Alerts/Changes work an earlier session left uncommitted. Plan: the panel on FlexDesk's createBottomPanelTabs; the Alerts tab is mountAlertsPane over one createAlertLog whose source merges this copy's log and the tracker copy's; the bell reads that log. alerts.js keeps the rules, their checking, the saved log and the editor.

### 2026-10-14T18:02Z · norman_agent

Handing back for review. Built on main as d611e1c (on top of 91d7c7b, the STORY-0005 batch an earlier session had left uncommitted).

- Tabs: `mountTicketBottomPanel` is FlexDesk's `createBottomPanelTabs`, with Alerts and Changes both eager so their counts are right before you open them, the last tab remembered in localStorage (`bugdesk.bottomTab`), and the tile title following the tab.
- Alerts: `mountAlertsTab` in alerts.js is FlexDesk's `mountAlertsPane` over `sharedAlertLog()`, one `createAlertLog` whose source merges the page's copy and the tracker copy. Ids are prefixed per copy, and read/dismiss go back to the copy an entry came from. The rules column, still-matches, the store tag, the footer and the empty texts are the pane's options.
- Bell: NotificationHistory gets `alertLog: sharedAlertLog(...)` and `onOpen`, which opens the panel on Alerts, the same as "+N more".
- Removed: alerts.js's pane, ago/dayLabel/worstLevel, pages.js's hand-built strip and the `.bd-alerts*` CSS. The rules, their checking, the saved log and the editor are unchanged.

Checked: check-graph, eslint (0 errors), test-ui 221, test-tracker 34, test-dom 198 (the Alerts test is rewritten for the shared pane, two copies with clashing ids, and the bell) and the four dashboard suites all pass. Also seen in headless Edge against a throwaway store, with real mouse input:
- the bell showed 2 in the alert colour;
- a click opened the panel on Alerts;
- Open marked the alert read (bell 1, warning colour; the tab badge followed);
- after a reload, the tab came back on Changes and the read state was kept.

Two things for you to look at: the bottom panel's default height leaves the alert list about 20px, which is the same as before this change; and the ref keeps FlexDesk's focus highlight after a click.
