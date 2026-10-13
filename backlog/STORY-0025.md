---
id: 25
type: story
title: "Package BugDesk as a Windows desktop app"
status: draft
parent: 21
phase:
assignee:
reporter: norman
due:
points:
subsystem: desktop
labels: [desktop]
links: [relates-to 9]
created: 2026-10-13
updated: 2026-10-13T05:11Z
---

## Description

The spike's prototype (`desktop/BugDesk.Desktop`) as a product: the server's startup moved into a method the console server and the desktop app both call (no reflection on its entry point), a graceful stop before the process ends, one instance per user (a second launch brings the first window forward), BugDesk's icon as `.ico` with the AppUserModelID and taskbar fixes SixShare uses, the plain `net10.0` target (1.5 MB instead of 26), `projects.toml` and the state folder in the user's app data, and an installer.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

_(not refined yet)_
