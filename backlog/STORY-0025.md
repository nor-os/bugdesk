---
id: 25
type: story
title: "Package BugDesk as a Windows desktop app"
status: review
parent: 21
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: desktop
labels: [desktop]
links: [relates-to 9]
created: 2026-10-13
updated: 2026-10-14T15:20Z
---

## Description

The spike's prototype (`desktop/BugDesk.Desktop`) as a product: the server's startup moved into a method the console server and the desktop app both call (no reflection on its entry point), a graceful stop before the process ends, one instance per user (a second launch brings the first window forward), BugDesk's icon as `.ico` with the AppUserModelID and taskbar fixes SixShare uses, the plain `net10.0` target (1.5 MB instead of 26), and `projects.toml` and the state folder in the user's app data. Packaging is STORY-0040.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [x] Starting `BugDesk.exe` opens BugDesk in a native window within 10 s, with no console window, while another BugDesk (the console server on 8766) keeps running undisturbed
- [x] Starting it a second time as the same user brings the open window to the front and exits; no second server starts on the same stores
- [x] Closing the window stops the server cleanly: an edit saved just before closing is on disk afterwards, and the process exits within 5 s
- [ ] The window, the taskbar button and a pinned taskbar shortcut show BugDesk's icon and group as one app
- [x] The app's `projects.toml` and per-user state are under `%AppData%\BugDesk`; nothing is written beside the executable, and a first launch with no projects asks for a project folder with the native folder picker and opens it (cancelling closes the app)

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 5 criteria, 5 points. Split the installer and the portable zip out
into STORY-0040, which you asked for both of; this story is the app itself.
Single instance, graceful stop, icon and AppUserModelID, app-data folder.

### 2026-10-14T15:20Z · norman_agent (status: in-progress -> review)

Built in b7c6429. Four of five criteria ticked; the taskbar one needs you.

- **Server startup** is `BugDeskServer.Run(args, built)` in `server/Program.cs`
  (the body is not re-indented, so the diff is 19 lines). The console server's
  entry point is the new `server/Entry.cs`. The app keeps the `WebApplication`
  and calls `StopAsync` when the window closes, so no more reflection.
- **Checked on the real app**, built with Windows dotnet and driven over CDP
  against a scratch store, while your BugDesk kept running on 8766:
  - the shell was up in 2.4 s;
  - a second launch exited in 95 ms, still one `BugDesk.exe`, and the
    minimised first window was restored and in the foreground;
  - a title saved through the API just before closing was on disk, and the
    process exited 0.4 s after the close;
  - the window has small and large icons (WM_GETICON);
  - nothing was written beside the executable.
- **I changed criterion 5.** It said the first launch shows "BugDesk's usual
  add-a-project page", but there isn't one: with no projects the server
  answers `/` with a 404 text. The app now writes an empty `projects.toml`
  (otherwise the server would seed a project from its install folder) and
  asks with the native folder picker. I checked both ways: picking a repo
  added it as a project and opened `/p/<name>/`; cancelling closed the app.
  If you'd rather have an in-page form, say so.
- **Criterion 4 is not ticked.** The process sets the AppUserModelID
  `BugDesk.Desktop` and the window and exe carry the new icon
  (`ui/assets/icons/bugdesk.ico`, rendered from the SVGs). Whether a pinned
  taskbar shortcut groups with the running window needs a person to pin it.
  To check: build with
  `dotnet build desktop\BugDesk.Desktop -o desktop\BugDesk.Desktop\bin\dev`,
  start `bin\dev\BugDesk.exe`, pin it, close it, then start it from the pin.
  The MSI shortcut gets the same ID in STORY-0040.
- `docs/desktop.md` describes the app. The CHANGELOG entry replaces the
  prototype's.
