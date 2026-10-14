---
id: 27
type: story
title: "Desktop build for Linux"
status: in-progress
parent: 21
phase:
assignee: norman_agent
reporter: norman
due:
points: 3
subsystem: desktop
labels: [desktop]
links: [requires 25]
created: 2026-10-13
updated: 2026-10-14T16:00Z
---

## Description

Linux: Photino's WebKitGTK (`libwebkit2gtk-4.1`), a PNG icon, a `.desktop` file, a `.deb` that declares the WebKitGTK dependency, plus a plain `.tar.gz`; no handle-based window code (Photino's WindowHandle throws there). macOS is STORY-0041.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [ ] One script builds `bugdesk_<version>_amd64.deb` and a `.tar.gz` from the checkout on Linux
- [ ] Installed from the `.deb` on Ubuntu, BugDesk shows in the application launcher with its icon and opens in a native window
- [ ] The `.deb` depends on `libwebkit2gtk-4.1-0`, and the bare binary started without that library exits with a message naming the package rather than a stack trace
- [ ] Single instance, the clean stop and the app-data folder (`~/.config/BugDesk`) behave as on Windows (STORY-0025)
- [ ] Nothing in the Linux path touches the native window handle

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 5 criteria, 3 points, Linux only. You chose to split macOS off: it
is STORY-0041, left draft until there is a Mac and an Apple developer ID. A
`.deb` rather than an AppImage, because the package can declare the
WebKitGTK dependency, which is the main way it fails.
