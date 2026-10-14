---
id: 40
type: story
title: "Windows installer and portable build of the desktop app"
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
created: 2026-10-14
updated: 2026-10-14T15:25Z
---

## Description

Ship the Windows desktop app (STORY-0025) two ways: a per-user MSI built with WiX, as `../SixShare/Installer` does, for people who want it installed; and a portable, self-contained build in a zip for people who do not have, or do not want, .NET installed. Both carry `ui/` beside the executable. Split out of STORY-0025 during refinement.

## Acceptance criteria

- [ ] One script in the repo builds both the MSI and the zip from a clean checkout
- [ ] The MSI installs for the current user without an administrator prompt, adds a Start-menu shortcut with BugDesk's icon, and uninstalls without leaving the program folder behind (the user's `%AppData%\BugDesk` stays)
- [ ] Installing a newer MSI over an older one upgrades in place: one entry in Installed apps, not two
- [ ] The zip, unpacked anywhere, starts BugDesk on a machine with no .NET installed
- [ ] The framework-dependent app (excluding `ui/`) is under 5 MB

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> in-progress
- 2026-10-14 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-14T14:31Z · norman_agent

Filed and refined in one pass, split out of STORY-0025 when you asked for both a
per-user WiX MSI and a portable self-contained build: 5 criteria, 3 points.
Unsigned; SmartScreen will warn on first run until there is a certificate.
