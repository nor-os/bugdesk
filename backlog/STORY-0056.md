---
id: 56
type: story
title: "Polling file watcher so live updates work on WSL /mnt/c checkouts"
status: draft
parent: 
phase:
assignee:
reporter: norman
due:
points:
subsystem: unsorted
labels: [wsl]
links: []
created: 2026-10-20
updated: 2026-10-20T15:20Z
---

## Description

On a checkout under `/mnt/c` (a Windows drive seen from WSL), WSL reports no file change events, so BugDesk's `FileSystemWatcher` never fires: a record edited on disk (by an agent, by git, by an editor) does not reach the open page or the `/api/events` stream. BugDesk's own page misses these updates, and so does every host that embeds it (AI Desk STORY-0103 and STORY-0110, `../aidesk/backlog/`). Confirmed with a direct inotify probe during AI Desk phase 1; on a Linux-filesystem checkout the same edit arrives in about 300 ms.

An optional polling watcher (by setting, or chosen automatically for drvfs paths) would make live updates work there. Not parented: it is not embedding work, and no epic covers the server's file watching.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T15:20Z · norman_agent

Filed as a follow-up from STORY-0052 (embedding BugDesk), found while AI Desk phase 1 consumed the embed. Left draft for norman to refine.
