---
id: 27
type: story
title: "Desktop build for Linux"
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
updated: 2026-10-14T16:20Z
---

## Description

Linux: Photino's WebKitGTK (`libwebkit2gtk-4.1`), a PNG icon, a `.desktop` file, a `.deb` that declares the WebKitGTK dependency, plus a plain `.tar.gz`; no handle-based window code (Photino's WindowHandle throws there). macOS is STORY-0041.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

- [x] One script builds `bugdesk_<version>_amd64.deb` and a `.tar.gz` from the checkout on Linux
- [ ] Installed from the `.deb` on Ubuntu, BugDesk shows in the application launcher with its icon and opens in a native window
- [x] The `.deb` depends on `libwebkit2gtk-4.1-0`, and the bare binary started without that library exits with a message naming the package rather than a stack trace
- [x] Single instance, the clean stop and the app-data folder (`~/.config/BugDesk`) behave as on Windows (STORY-0025)
- [x] Nothing in the Linux path touches the native window handle

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T14:31Z · norman_agent

Refined: 5 criteria, 3 points, Linux only. You chose to split macOS off: it
is STORY-0041, left draft until there is a Mac and an Apple developer ID. A
`.deb` rather than an AppImage, because the package can declare the
WebKitGTK dependency, which is the main way it fails.

### 2026-10-14T16:20Z · norman_agent (status: in-progress -> review)

Built in 644368f. Four of five criteria are ticked; the launcher one needs a
real desktop.

- **The script** is `desktop/linux/build.sh`, not `desktop/build-linux.sh`. On
  the Windows drive a `bugdesk.desktop` file collides with the
  `BugDesk.Desktop` folder, because the drive is case-insensitive, so the
  Linux files live in `desktop/linux/`. Run in a clean worktree of 644368f,
  it built:
  - `bugdesk_0.2.0_amd64.deb`, 41 MB;
  - `bugdesk-0.2.0-linux-x64.tar.gz`, 51 MB.
  Both are self-contained.
- **The `.deb`, checked in a clean `ubuntu:24.04` container:**
  - `apt-get install ./bugdesk_0.2.0_amd64.deb` pulled in
    `libwebkit2gtk-4.1-0` and installed.
  - The launcher file passes `desktop-file-validate`, and the icon is in
    `hicolor/256x256`.
  - Started there with the WSLg display mounted, the installed `bugdesk`
    opened a native `BugDesk` window carrying the 256 px icon, and the page
    loaded (48 requests, up to the who-are-you prompt).
- **Missing WebKitGTK:** the tarball's `./BugDesk` in a bare `ubuntu:24.04`
  prints which package to install (apt and dnf) and exits 1, with no stack
  trace.
- **Same as Windows,** checked under WSLg:
  - a second launch, even from another session, exits in 0.15 s and leaves
    one process;
  - an edit saved just before closing is on disk, and closing the window
    exits in 0.2 s;
  - the app's folder is `~/.config/BugDesk`.
- **Criterion 2 is not ticked.** I could not see the entry in a real
  launcher: the container has no desktop, and I have no sudo here. To check:
  `! sudo apt install ./desktop/out/bugdesk_0.2.0_amd64.deb` in WSL (after
  `desktop/linux/build.sh`). WSLg should then list "BugDesk (Ubuntu)" in the
  Windows Start menu.
- **What testing turned up**, all fixed in this commit:
  - Under a Wayland session, Photino hung creating the window. The app now
    runs through XWayland: it sets `GDK_BACKEND=x11` unless one is set,
    with libc's `setenv`, because .NET's `SetEnvironmentVariable` does not
    reach GTK on Unix.
  - `Local\` mutexes are per POSIX session on Linux, so two terminals would
    have started two servers. It is `Global\` there now.
  - SIGTERM stopped the server but left the window open. The window now
    closes too.
- **Known:** under WSLg the window opens at its minimum size, 900 × 600.
  WSLg's window manager refuses resizes, including a plain X11 configure, so
  I can't tell whether a real desktop honours the 1400 × 900. STORY-0026
  will restore the last size anyway.
- `docs/desktop.md` has a Linux section.
