---
id: 25
type: story
title: "Package BugDesk as a Windows desktop app"
status: in-progress
parent: 21
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: desktop
labels: [desktop]
links: [relates-to 9]
created: 2026-10-13
updated: 2026-10-14T14:40Z
---

## Description

The spike's prototype (`desktop/BugDesk.Desktop`) as a product: the server's startup moved into a method the console server and the desktop app both call (no reflection on its entry point), a graceful stop before the process ends, one instance per user (a second launch brings the first window forward), BugDesk's icon as `.ico` with the AppUserModelID and taskbar fixes SixShare uses, the plain `net10.0` target (1.5 MB instead of 26), and `projects.toml` and the state folder in the user's app data. Packaging is STORY-0040.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [ ] Starting `BugDesk.Desktop.exe` opens BugDesk in a native window within 10 s, with no console window, while another BugDesk (the console server on 8766) keeps running undisturbed
- [ ] Starting it a second time as the same user brings the open window to the front and exits; no second server starts on the same stores
- [ ] Closing the window stops the server cleanly: an edit saved just before closing is on disk afterwards, and the process exits within 5 s
- [ ] The window, the taskbar button and a pinned taskbar shortcut show BugDesk's icon and group as one app
- [ ] The app's `projects.toml` and per-user state are under `%AppData%\BugDesk`; nothing is written beside the executable, and a first launch with no projects shows BugDesk's usual add-a-project page

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 5 criteria, 5 points. Split the installer and the portable zip out
into STORY-0040, which you asked for both of; this story is the app itself.
Single instance, graceful stop, icon and AppUserModelID, app-data folder.
