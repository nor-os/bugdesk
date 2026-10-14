---
id: 40
type: story
title: "Windows installer and portable build of the desktop app"
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
created: 2026-10-14
updated: 2026-10-14T15:55Z
---

## Description

Ship the Windows desktop app (STORY-0025) two ways: a per-user MSI built with WiX, as `../SixShare/Installer` does, for people who want it installed; and a portable, self-contained build in a zip for people who do not have, or do not want, .NET installed. Both carry `ui/` beside the executable. Split out of STORY-0025 during refinement.

## Acceptance criteria

- [x] One script in the repo builds both the MSI and the zip from a clean checkout
- [x] The MSI installs for the current user without an administrator prompt, adds a Start-menu shortcut with BugDesk's icon, and uninstalls without leaving the program folder behind (the user's `%AppData%\BugDesk` stays)
- [x] Installing a newer MSI over an older one upgrades in place: one entry in Installed apps, not two
- [x] The zip, unpacked anywhere, starts BugDesk on a machine with no .NET installed
- [x] The framework-dependent app (excluding `ui/`) is under 5 MB

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-14 · norman_agent · status: in-progress -> review
- 2026-10-14 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-14T14:31Z · norman_agent

Filed and refined in one pass, split out of STORY-0025 when you asked for both a
per-user WiX MSI and a portable self-contained build: 5 criteria, 3 points.
Unsigned; SmartScreen will warn on first run until there is a certificate.

### 2026-10-14T15:55Z · norman_agent (status: in-progress -> review)

Built in 12326f8. All five criteria are ticked, each checked on this machine.

- **The script.** `desktop/build-windows.ps1` writes into `desktop/out/`
  (git-ignored). I ran it in a clean worktree of 12326f8, and it built both
  packages with 0 warnings in 77 s:
  - `BugDesk-0.2.0-win-x64.msi`, 42 MB;
  - `BugDesk-0.2.0-win-x64-portable.zip`, 48 MB.
  The version defaults to `package.json`'s.
- **The MSI** (WiX 5, `desktop/installer/`, modelled on SixShare's):
  - `msiexec /i … /qn` installed it with no prompt. The log says "Package is
    marked as LUA installation capable with no elevation required".
  - It installs to `%LocalAppData%\Programs\BugDesk`, with a Start-menu
    `BugDesk.lnk` that has the icon and the `BugDesk.Desktop` AppUserModelID.
  - The installed app ran: shell in 2.5 s, single instance and a clean close.
  - Installing a 0.2.1 MSI over 0.2.0 left one product, at 0.2.1.
  - Uninstalling removed the program folder and the shortcut, and left
    `%AppData%\BugDesk` alone.
  - I uninstalled it again afterwards. One thing you may notice: a
    `BugDesk.lnk` from the spike was already in your Start menu, pointing at
    the spike's deleted build. The test install replaced it and the uninstall
    removed it.
- **The zip** holds one self-contained `BugDesk.exe` (51 MB, compressed
  single-file, Photino's native libraries inside) and `ui/`, without its
  source maps.
  - Unpacked elsewhere, it ran: shell in 1.8 s, single instance, clean close.
  - It loads no module from `C:\Program Files\dotnet`; the dev build loads
    112 from there, `hostfxr` among them. That is my evidence that it needs no
    .NET installed. I have no machine without .NET to try it on.
  - The first zip had backslashes in its entry names (Windows PowerShell's
    `Compress-Archive`), so it is now built with `tar.exe`.
- **Size:** the framework-dependent app is 1.4 MB without `ui/`. The packages
  ship self-contained, so that nobody has to install the ASP.NET Core runtime
  first. The framework-dependent build is only measured, not shipped.
- **Unsigned:** SmartScreen will warn on the first run.
