---
id: 26
type: story
title: "BugDesk uses the native host in the desktop app"
status: review
parent: 21
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: desktop
labels: [desktop]
links: [requires 25]
created: 2026-10-13
updated: 2026-10-14T17:38Z
---

## Description

With FlexDesk's Photino host (FlexDesk STORY-0015, `../FlexDesk/backlog/STORY-0015.md`), BugDesk asks the window for what a browser tab cannot give: its size and place remembered, and the native save dialog for exports. In a browser tab nothing changes (`NULL_HOST`).

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [x] In the desktop app, exporting a table or chart to CSV/PNG opens the native Save dialog and writes the file where you chose; cancelling writes nothing and says nothing was saved
- [x] The desktop window comes back at its last size, position and maximised state; if that position is on a monitor that is gone, it opens centred on the primary one
- [x] FlexDesk draws no window buttons of its own in the desktop window (the native title bar is the only one)
- [x] In a browser tab nothing changes: exports download as before, and no host error reaches the console

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 4 criteria, 3 points. Requires FlexDesk STORY-0015 (refined today,
`../FlexDesk/backlog/STORY-0015.md`) and a FlexDesk release carrying it; you
agreed to publish that when it is ready. The tile layout and table state keep
going through the server, as now, so the host's `state` stays BugDesk's.

### 2026-10-14T17:05Z · norman_agent

Built in e61dfb3, on FlexDesk 0.14.0, which I synced in e9b4b25. Three of four
criteria are ticked. The export criterion needs your decision, so the story
stays with me, in progress.

- **Window placement**, checked in the real app over the bridge:
  - default 1400 × 900, centred;
  - bounds set over the bridge come back after a restart;
  - a window closed maximised opens maximised and un-maximises to its
    remembered 1100 × 750 at (100, 120);
  - a saved place at (-30000, -30000) opened centred on the primary monitor.
  Along the way I found that the window had never got its 1400 × 900: Photino
  used the OS default size, and a minimum set before creation became the size.
  Both are fixed.
- **No window buttons:** in the desktop window `isPhotinoWindow()` is true and
  the host's `chrome()` is `native`. BugDesk doesn't mount FlexDesk's
  window-chrome controller at all.
- **Browser tab:** headless Edge against a scratch server. `isPhotinoWindow()`
  is false, the shell came up, and there were no console errors. The desktop
  window had no console errors either.
- **Criterion 1 (exports) is not ticked**, for two reasons:
  1. BugDesk has no export today. FlexDesk's DataTable can show a "Download
     visible rows as CSV" button (`showExportButton`) and use the host's save
     dialog (`host`), but `bd_table.js` passes neither. The only other
     exports are the chart tiles in the dashboards work (EPIC-0033), which
     isn't committed yet.
  2. The native dialog itself works: `dialogs.saveFile` opens Photino's Save
     dialog, titled "Save <name>", and Cancel answers `cancelled` and writes
     nothing. I could not automate typing a name into the modern Save
     dialog, so a real save is untested. Also, Photino's dialog can't
     pre-fill a file name; the suggested name is in its title, and the
     extension is added if the typed name has none.

  **Question for you:** should BugDesk's tables get FlexDesk's CSV download
  button (in browser tabs too, where it downloads as now), or should this
  criterion become "the native Save dialog backs every export FlexDesk
  offers", leaving the dashboards to pick it up?

### 2026-10-14T17:38Z · norman_agent

Your answer was "charts and tables", so all four criteria are ticked now. The code is in b2198c0, on FlexDesk 0.14.1 (published to npm today):

- **FlexDesk 0.14.1** (FlexDesk STORY-0024 and STORY-0025, `../FlexDesk/backlog/`, both with you for review):
  - a chart tile's Download PNG goes through the host's `dialogs`;
  - DataTable's CSV button is drawn on a one-page table too, and takes an `exportFilename`.
- **Every list** (bug queue, backlog board, search results) now has *Download visible rows as CSV* in its strip. It goes through `ctx.host`, and the file is named after the view (`active.csv`, `backlog.csv`, `search-results.csv`).
- **Dashboard tiles** get `host` (bugdesk-d6 added that line in 0519f90). I made the grid's eventBus stub forward `toast:show`, because the "Chart saved to …" toast was being dropped.

Checked in the real desktop app (bin/e26, scratch project, CDP). A real save works now: characters posted straight to the dialog's own file-name box, never SendKeys.

- Bug queue CSV: the dialog is "Save active.csv". Cancel writes nothing and shows no toast. Save writes the rows and toasts "Saved 1 rows to <path>". A typed name without an extension gets `.csv`.
- Dashboard chart PNG: the dialog is "Save bugs-burndown.png". Cancel writes nothing. Save writes a valid 48 KB PNG and toasts "Chart saved to <path>".
- Backlog board: the button opens "Save backlog.csv".
- Browser tab (headless Edge on the same server): `isPhotinoWindow()` is false. The CSV and the PNG download as files, with no console errors or warnings.

Two changes for browser tabs too: every list now has the CSV button, which downloads as before, and a one-page list shows a thin strip that holds only that button. Suites: FlexDesk 94/94; BugDesk DOM 193, UI 221 and check-graph, run in a clean worktree at b2198c0. This was the last open criterion in EPIC-0021. Only STORY-0041 (macOS) is left there, still in draft until there is a Mac.
