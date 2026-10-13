---
id: 9
type: story
title: "Spike: desktop app via webview"
status: review
parent: 21
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: unsorted
labels: []
links: [requires 23]
created: 2026-10-05
updated: 2026-10-13T05:12Z
---

## Description

../EcoSim uses webview quite well. Maybe we can do the same for bugdesk, turning it into an actual desktop app?`

In any case - we should add the capabilities to flexdesk directly (see in ../FlexDesk). We later on will migrate EcoSim to FlexDesk.

_Host decided: Photino.NET, as in ../SixShare (SixShare.Desktop)._

## Acceptance criteria

- [x] A prototype opens BugDesk in a native Photino.NET window on Windows, with the BugDesk server running in-process, following SixShare.Desktop (`../SixShare/SixShare.Desktop/Program.cs`)
- [x] A Photino host for FlexDesk's host port (`@flexdesk/host`, next to its `pywebview_host.js`) is designed: capabilities sent over `window.external.sendMessage` as JSON, as in SixShare's `WebUI/src/launcher/nativeBridge.ts`, with the browser fallback the host port already gives (`NULL_HOST`)
- [x] A findings note in `docs/` covers Linux and macOS (what SixShare needed: PNG icon on Linux, the tray, Windows taskbar and icon fixes), packaging and size
- [x] Build stories for EPIC-0021 are filed from the findings
- [x] Timeboxed at 3 points: if it overruns, stop and report what is known

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-13 · norman_agent · status: refined -> in-progress
- 2026-10-13 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 3 points, as a spike under EPIC-0021. Following your note, the host
is Photino.NET, as in SixShare, so the spike no longer compares hosts. It covers
the FlexDesk bridge design (SixShare's `nativeBridge.ts` pattern, generalised so
EcoSim can use it later) and a working prototype. If you'd rather skip the spike
and go straight to building, it can be turned into a normal story.

### 2026-10-11T13:39Z · norman_agent

Updated for FlexDesk 0.7.0: it already has a host port (`@flexdesk/host`)
with a pywebview host, so the spike designs a Photino host for that port instead
of a bridge of our own. Still 3 points. Requires STORY-0023.

### 2026-10-13T05:12Z · norman_agent (status: in-progress -> review)

Spike done in ae17859, within its three points. All five criteria are met.

- **Prototype:** `desktop/BugDesk.Desktop` (about 120 lines) runs the server
  in-process. It calls the server's entry point on a background thread, on a
  free loopback port so it never collides with your BugDesk on 8766, then
  opens a Photino.NET 4.0.16 window on it, following SixShare.Desktop.
- **Checked:** I started it minimised against a scratch store, with WebView2's
  debug port open, and stopped it a few seconds later. It may have flashed in
  your taskbar.
  - The page loaded in the Photino window (title "BugDesk", the shell up).
  - `window.external.sendMessage({id:1, cap:'host', op:'describe'})` came back
    as `{"id":1,"ok":true,"value":{"host":"photino","version":"4.0.16.0",…}}`.
  - `window.isMaximized` answered `false`.
- **The Photino host for `@flexdesk/host`** is designed in
  `docs/desktop-spike.md`: the `{id, cap, op, args}` → `{id, ok, value|error}`
  protocol over `window.external`, an adapter sketch for FlexDesk's
  `src/host/photino_host.js` beside `pywebview_host.js`, the C# dispatcher
  table, and the `NULL_HOST` fallback in a browser tab. Filed as FlexDesk
  STORY-0015 (`../FlexDesk/backlog/STORY-0015.md`).
- **Findings note** (`docs/desktop-spike.md`):
  - Windows: WebView2 is present; it needs an `.ico`, which BugDesk lacks;
    plus SixShare's AppUserModelID and taskbar fixes.
  - Linux: WebKitGTK, a PNG icon, and WindowHandle throws.
  - macOS: an `.app` bundle, signing and notarisation.
  - Packaging: the spike's build is 26 MB, of which 24 MB is the Windows SDK
    projection; plain `net10.0` is about 1.5 MB plus the 12 MB `ui/`.
    Self-contained adds the runtime.
  - Risks: the reflection call on the entry point, shutdown, and the free
    port.
- **Build stories filed** under EPIC-0021: STORY-0025 (Windows desktop app),
  STORY-0026 (BugDesk on the native host), STORY-0027 (Linux and macOS). All
  are drafts, for you to refine.
