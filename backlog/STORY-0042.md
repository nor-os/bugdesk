---
id: 42
type: story
title: "The desktop window draws its own chrome: frameless, with BugDesk's top bar as the title bar"
status: review
parent: 21
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: desktop
labels: [desktop]
links: []
created: 2026-10-14
updated: 2026-10-14T18:33Z
---

## Description

EcoSim's desktop window had no native frame. Its own top bar was the title bar:
you dragged the window by it, it had minimise, maximise and close buttons, and
the window was resized from its edges. BugDesk's desktop window has the OS title
bar above BugDesk's own top bar, which costs a row of screen and looks like a
web page in a window rather than an app.

The STORY-0009 spike chose the native frame on purpose (`docs/desktop-spike.md`,
"Chrome"): Photino cannot do a frameless window as reliably as pywebview did on
Windows. STORY-0026 made that an acceptance criterion ("the native title bar is
the only one"). This story revisits the decision. It is not trivial, so it starts
with a short trial in WebView2 to see whether snapping, resizing and the window
shadow are good enough before anything is built.

What already exists:

- FlexDesk's `WindowChromeController` (ported from EcoSim) draws resize handles,
  wires `#win-minimize` / `#win-maximize` / `#win-close`, drags the window by
  the top bar and syncs the maximised state. It runs only when the host's
  `window.chrome()` answers `custom`.
- The desktop app's `NativeBridge.cs` already answers `minimize`, `close`,
  `isMaximized` / `setMaximized`, `toggleFullscreen` and `getBounds` /
  `setBounds`.

What BugDesk has to do:

- Open the Photino window chromeless, and say so to the page, so that
  FlexDesk's Photino host answers `custom` (today it hardcodes `native`).
- Put minimise, maximise and close buttons at the right of the top bar, in the
  desktop window only. A browser tab keeps exactly the top bar it has now.
- Keep what the native frame gives for free, or decide knowingly to lose it:
  Aero Snap and Win+arrow keys, double-click to maximise, the window shadow and
  rounded corners on Windows 11, the system menu (Alt+Space), and the taskbar's
  minimise/restore. Each needs a stated result: works, replaced, or accepted as lost.
- Linux keeps its native frame in this story. WebKitGTK under XWayland is a
  separate pass, and WSLg can't verify window sizes anyway.
- Amend STORY-0026's criterion and `docs/desktop.md` once this is decided.

The FlexDesk side is FlexDesk STORY-0026 (`../FlexDesk/backlog/STORY-0026.md`):
the Photino host reporting custom chrome, the window buttons' markup and CSS,
and the drag area no longer depending on EcoSim's class names.

## Acceptance criteria

- [x] In the Windows desktop window there is no OS title bar. BugDesk's top bar is the top edge of the window, with minimise, maximise/restore and close buttons at its right, and dragging an empty part of it moves the window
- [x] Dragging the top bar to a screen edge snaps the window like a native one (half screen, maximised, Windows 11 snap layouts on hover over maximise), and Win+←/→/↑/↓ work
- [x] Double-clicking an empty part of the top bar maximises and restores, and the maximise button's icon follows the state however it changed (button, double-click, snap, Win+↑)
- [x] The window resizes from all four edges and corners, with the edge staying under the pointer during the drag, and not below 900×600
- [x] The window keeps its shadow and, on Windows 11, its rounded corners; maximised, it fills the work area without covering the taskbar or losing a strip of pixels at any edge
- [x] Alt+F4 and the close button both shut down cleanly, as closing does today. Clicking the taskbar button minimises and restores the window, and the size, position and maximised state still come back on the next start
- [ ] In a browser tab, and in the Linux desktop window, the top bar is exactly what it is today, with no window buttons
- [x] `docs/desktop.md` describes the frameless window and why Linux keeps its frame, and STORY-0026's "native title bar only" criterion is amended to point here

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T17:52Z · norman_agent

Filed at norman's request after comparing with EcoSim's frameless window. The
FlexDesk half is FlexDesk STORY-0026. Refinement should start from the trial:
what Photino's chromeless mode does to snapping, resizing and the shadow in
WebView2.

### 2026-10-14T18:01Z · norman_agent

Refined: 8 acceptance criteria, 5 points, under EPIC-0021. The criteria are
written against what a native window does, so the trial decides how, not
whether, each one holds: Photino's own chromeless mode, or the native frame
kept with its title bar removed (the window keeps its resize border, snapping,
shadow and rounded corners, and the top bar hands drags and resizes to Windows).
Linux is left out on purpose: it keeps the native frame here. If the trial
shows a criterion can't be met with Photino, that goes back to norman before
anything is built against it. FlexDesk's half (the host reporting custom chrome,
the buttons' markup and CSS, the drag area's names) stays FlexDesk STORY-0026.

### 2026-10-14T18:09Z · norman_agent

Trial, first results (Windows 11, on branch `story-0042-trial`, commit 1bf532d;
not on main). Two frameless variants behind `BUGDESK_DESKTOP_FRAME`, both
driven by FlexDesk's own `WindowChromeController`, unchanged:

- **`photino`, Photino's own chromeless window: ruled out.** It's a bare
  `WS_POPUP` window (style 0x94000000): no Aero Snap, no Win+arrows, square
  corners, no shadow. Photino also reports it as fullscreen, so the controller
  turns its resize handles off and the window can't be resized at all.
- **`custom`, the native frame kept but not drawn: works so far.** The window
  keeps `WS_CAPTION | WS_THICKFRAME` and a window subclass (`CustomFrame.cs`)
  returns the whole window as client area from `WM_NCCALCSIZE`. Measured: the
  client area is the whole 1400×900 window, so the page reaches the top edge.
  Rounded corners and the shadow are there. The maximise button maximises to
  exactly the monitor's work area (5120×1392, taskbar visible, no strip lost),
  restores to 1400×900, and its icon follows both ways. Drags and resizes are
  handed to Windows (`WM_NCLBUTTONDOWN` with `HTCAPTION` or an edge), which is
  what should bring snapping and a resize that keeps up with the pointer.

Still to check by hand, because it needs a real mouse and keyboard: dragging and
snapping, Win+arrows, edge and corner resizing, double-click on the top bar,
Alt+F4 and the taskbar button. Two findings already point at FlexDesk
STORY-0026: the controller only finds BugDesk's top bar once it carries the
`twm-global-top-bar` class, and nothing in FlexDesk draws the window buttons.
Snap layouts on hovering the maximise button look out of reach, because the
WebView2 covers the window and Windows never sees the hover. I'll confirm or
drop that criterion with norman.

### 2026-10-14T18:33Z · norman_agent

Built: fdf2598 on main, on FlexDesk 0.15.0 (FlexDesk STORY-0026, released and
on npm). You had already moved this to review and ticked the first six
criteria in the UI. My handback commit (5352548) picked those edits up before
mine were written, so that commit is yours, not a handback. This one assigns
the story to you and ticks the docs criterion.

- `desktop/BugDesk.Desktop/CustomFrame.cs` (from the trial): the window keeps
  `WS_CAPTION | WS_THICKFRAME`, the subclass returns the whole window from
  `WM_NCCALCSIZE` (the work area while maximised), and DWM keeps the shadow and
  rounded corners. `startDrag` / `startResize` hand gestures to Windows with
  `WM_NCLBUTTONDOWN`. `host.describe` says `frame: "custom"`; with
  `BUGDESK_DESKTOP_FRAME=native` it says `"native"` and the standard frame is
  back. Photino's `SetChromeless` is not used.
- `install.js` starts FlexDesk's `WindowChromeController` in a Photino window,
  with BugDesk's top bar and its `.bar-right` for the buttons. The trial's
  script and CSS are not on main; the local branch `story-0042-trial` is no
  longer needed.
- `.\run.ps1` builds this app, so it now opens the frameless window.

Verified on the final build:
- The default window has the buttons and 8 handles, and its edges hit-test to
  the handles.
- Maximised, it fills exactly the work area.
- A browser tab on the same server has no buttons, no handles and no body
  class.
- `BUGDESK_DESKTOP_FRAME=native` has the Windows title bar back and nothing
  from FlexDesk.

All suites pass, also on the commit alone in a clean worktree.

Left for you:
- **The criterion you ticked mentions snap layouts on hover over maximise.**
  That part doesn't work: Windows never sees the pointer over the page's
  button. Dragging to an edge, Win+arrows and Win+Z all work.
- **Criterion 7 is unticked.** A browser tab is verified unchanged. Linux keeps
  its native frame by construction (the custom frame is Windows-only), but I
  didn't run the Linux build.
- STORY-0026's "native title bar only" criterion now points here.
