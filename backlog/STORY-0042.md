---
id: 42
type: story
title: "The desktop window draws its own chrome: frameless, with BugDesk's top bar as the title bar"
status: draft
parent: 21
phase:
assignee:
reporter: norman
due:
points:
subsystem: desktop
labels: [desktop]
links: []
created: 2026-10-14
updated: 2026-10-14T17:52Z
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
- Linux (WebKitGTK under X11/XWayland) needs the same pass, or stays native there.
- Amend STORY-0026's criterion and `docs/desktop.md` once this is decided.

The FlexDesk side is FlexDesk STORY-0026 (`../FlexDesk/backlog/STORY-0026.md`):
the Photino host reporting custom chrome, the window buttons' markup and CSS,
and the drag area no longer depending on EcoSim's class names.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-14T17:52Z · norman_agent

Filed at norman's request after comparing with EcoSim's frameless window. The
FlexDesk half is FlexDesk STORY-0026. Refinement should start from the trial:
what Photino's chromeless mode does to snapping, resizing and the shadow in
WebView2.
