---
id: 44
type: story
title: "Settings opens in a large modal dialog, like Help, instead of a tab"
status: review
parent: 19
phase:
assignee: norman
reporter: norman
due:
points: 2
subsystem: settings
labels: []
links: []
created: 2026-10-14
updated: 2026-10-14T18:48Z
---

## Description

Settings opens as a tab in the main tile, so it takes the place of whatever you
were working on and stays among your tabs afterwards. Help opens as a modal over
the workspace and is gone when you close it. Settings should behave like Help,
in a larger dialog because its pages (Record types, Workflow, Team) are wider
than a help article.

## Acceptance criteria

- [x] While it is open, the top bar and the status bar stay clickable and unblurred
- [x] The menu's Settings entry opens Settings in a modal dialog over the workspace, and no tab is added to any tile
- [x] The dialog is larger than Help: up to 1280×860, never more than about 92% of the window, and it can be maximised
- [x] Every button that sends you to a Settings page (the snooze notice's "Record types", say) opens the dialog on that page; with the dialog already open it switches to that page instead of opening a second dialog
- [x] Esc, the X and the Close button close it (a click beside it does not, as with every FlexDesk managed modal), and the next time it opens it starts fresh
- [x] Every Settings page works in the dialog as it did in the tab: search, the sidebar, the project editors' Save / Discard, and the reload hint
- [x] A layout saved with a Settings tab in it still opens (the tab still shows Settings)

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T18:38Z · norman_agent

Filed at norman's request: "settings should (like help) pop up in a modal (but
larger than help)".

### 2026-10-14T18:38Z · norman_agent

Refined: 6 acceptance criteria, 2 points, under EPIC-0019. The dialog is
FlexDesk's `openModal` (maximizable), with the same Settings page mounted inside
it, so nothing about the pages changes. The `settings` content kind stays
registered, so a desktop layout saved with a Settings tab still opens.

### 2026-10-14T18:43Z · norman_agent

Built on main (the commit before this one). `openSettings()` in
`settings_content.js` mounts the same Settings page in FlexDesk's `openModal`
(Settings icon, maximizable, up to 1280×860 and about 92% of the window). The
menu's Settings entry calls it, and a call while the dialog is open switches
it to the page asked for. The `settings` content kind stays registered, so a
saved layout with a Settings tab still opens.

Two changes to the criteria:
- **Added the rule you gave while I was building it:** the top bar and the
  status bar stay clickable and unblurred. FlexDesk's managed modal does that
  by design (its backdrop runs from 35px to 20px above the bottom, which are
  BugDesk's bar heights). Help didn't: its overlay covered the whole screen,
  so `help.css` now gives it the same bounds.
- **Changed the closing criterion:** a click on the backdrop doesn't close it.
  No FlexDesk managed modal does, even though `openModal`'s doc comment says
  so (a FlexDesk doc bug). For Settings it's the safer behaviour: a stray
  click doesn't throw away unsaved edits in Record types or Workflow. Say if
  you want backdrop-click to close it after all.

Verified in a real desktop window (scratch config, CDP):
- From the menu: the dialog is 1280×777 in a 1400×900 window, the backdrop
  runs exactly from 35 to 880, clicks on both bars reach the bars, and no tab
  is added.
- Switching while open: Team, then Workflow, then Record types, in the same
  single dialog.
- Esc, X and Close each close it, and it reopens fresh.
- Record types shows its Discard / Save. The search finds "agent".
- `openInPrimary('settings')` still shows Settings in a tile.
- Help's overlay now spans 35 to 880 too.
- All suites pass. The reload hint wasn't exercised; it's the same page code.

### 2026-10-14T18:48Z · norman_agent

Removed the gap you pointed out between the Settings page and the dialog's
title bar and sides. It was FlexDesk's 14px margin on the modal's content
area. `settings_page.css` drops it for this dialog only, with a selector more
specific than FlexDesk's, since FlexDesk's stylesheet loads later. Measured
in the desktop window: the page now starts exactly at the dialog's content
edge on the top, left and right.
