---
id: 9
type: story
title: "Spike: desktop app via webview"
status: refined
parent: 21
phase:
assignee:
reporter: norman
due:
points: 3
subsystem: unsorted
labels: []
links: [requires 23]
created: 2026-10-05
updated: 2026-10-11T13:39Z
---

## Description

../EcoSim uses webview quite well. Maybe we can do the same for bugdesk, turning it into an actual desktop app?`

In any case - we should add the capabilities to flexdesk directly (see in ../FlexDesk). We later on will migrate EcoSim to FlexDesk.

_Host decided: Photino.NET, as in ../SixShare (SixShare.Desktop)._

## Acceptance criteria

- [ ] A prototype opens BugDesk in a native Photino.NET window on Windows, with the BugDesk server running in-process, following SixShare.Desktop (`../SixShare/SixShare.Desktop/Program.cs`)
- [ ] A Photino host for FlexDesk's host port (`@flexdesk/host`, next to its `pywebview_host.js`) is designed: capabilities sent over `window.external.sendMessage` as JSON, as in SixShare's `WebUI/src/launcher/nativeBridge.ts`, with the browser fallback the host port already gives (`NULL_HOST`)
- [ ] A findings note in `docs/` covers Linux and macOS (what SixShare needed: PNG icon on Linux, the tray, Windows taskbar and icon fixes), packaging and size
- [ ] Build stories for EPIC-0021 are filed from the findings
- [ ] Timeboxed at 3 points: if it overruns, stop and report what is known

## History

- 2026-10-06 · norman_agent · status: draft -> refined

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
