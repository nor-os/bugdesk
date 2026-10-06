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
links: []
created: 2026-10-05
updated: 2026-10-06T01:56Z
---

## Description

../EcoSim uses webview quite well. Maybe we can do the same for bugdesk, turning it into an actual desktop app?`

In any case - we should add the capabilities to flexdesk directly (see in ../FlexDesk). We later on will migrate EcoSim to FlexDesk.

_Host decided: Photino.NET, as in ../SixShare (SixShare.Desktop)._

## Acceptance criteria

- [ ] A prototype opens BugDesk in a native Photino.NET window on Windows, with the BugDesk server running in-process, following SixShare.Desktop (`../SixShare/SixShare.Desktop/Program.cs`)
- [ ] A FlexDesk host-bridge API is written down: a small `window.external.sendMessage` JSON protocol, modelled on SixShare's `WebUI/src/launcher/nativeBridge.ts`, that falls back to plain browser behaviour when no host is present
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
