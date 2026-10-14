---
id: 41
type: story
title: "Desktop build for macOS"
status: draft
parent: 21
phase:
assignee:
reporter: norman
due:
points:
subsystem: desktop
labels: [desktop]
links: [requires 25]
created: 2026-10-14
updated: 2026-10-14T14:31Z
---

## Description

macOS: Photino's WKWebView, an `.app` bundle with `Info.plist` and `.icns`, signed with an Apple developer ID and notarised, in a `.dmg`. `../SixShare/SixShare.Desktop.MacOS` and `Installer/Build-MacInstaller.ps1` show the bundle layout. Split out of STORY-0027; it waits for a Mac and an Apple developer ID to build and sign on.

From the STORY-0009 spike; see `docs/desktop-spike.md`.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-14T14:31Z · norman_agent

Split out of STORY-0027 at your request. Left draft: it cannot be built,
signed or notarised from the Windows/WSL machine, so nobody can say yet what
it costs.
