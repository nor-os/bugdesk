---
id: 61
type: story
title: "A host can hold a project's records: BugDesk reads and writes them through the host"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: hosting
labels: [embedding, store]
links: []
created: 2026-10-21
updated: 2026-10-21T07:19Z
---

## Description

AI Desk (`../aidesk`) keeps the bugs and backlog of the projects it manages in its own database (AI Desk EPIC-0167, `../aidesk/backlog/EPIC-0167.md`), to avoid record files fighting with git worktrees. norman (2026-10-21): "for bugdesk, nothing would change - we just intercept this layer. possibly, to enable this, we need to change something (like with embedding)."

BugDesk's store reads and writes BUG-/EPIC-/STORY-NNNN.md files (`server/Stores.cs`). This story opens one seam there, of the same kind as the embed contract (STORY-0052) and the settings folder (STORY-0060): a project in `projects.toml` can name a host record source (a URL plus a shared secret) instead of folders. BugDesk then lists, reads, writes, numbers and watches that project's records through the host. Views, rules, workflow and API stay as they are. A project without it behaves exactly as today.

## Acceptance criteria

- [ ] A project whose `projects.toml` entry names a record source has its records listed, read, created, changed, commented and moved through that source, and BugDesk's UI and API behave as on files
- [ ] Numbering for such a project comes from the source, so two clients never get the same number
- [ ] Changes announced by the source show in open views as live updates, just like file events
- [ ] With the source unreachable, BugDesk shows an error for that project and keeps other projects working
- [ ] A project without a record source behaves exactly as today (existing store tests pass unchanged)
- [ ] The contract (endpoints, payloads, auth) is documented in the README beside the embed contract

## History

- 2026-10-21 · norman_agent · filed as draft

## Comments
