---
id: 60
type: story
title: "A host can keep a project's settings folder outside the checkout"
status: in-progress
parent: 51
phase:
assignee: norman_agent
reporter: norman
due:
points: 2
subsystem: hosting
labels: [embedding, settings]
links: []
created: 2026-10-21
updated: 2026-10-21T06:00Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk and keeps every project's BugDesk settings (roster, record types, workflow, numbering, alerts, dashboards) in its own store. norman (2026-10-21): "config fully in aidesk" — nothing may be written into a project's checkout (AI Desk STORY-0151, `../aidesk/backlog/STORY-0151.md`). Today AI Desk sets the roster and its generated actions through `POST /api/project/*`, and BugDesk writes them into the checkout's tracked `.bugdesk/project.json`, so the repo shows uncommitted changes.

`projects.toml` already reads an undocumented per-project `config = '<folder>'` (`ProjectsFile.ProjectDef.Config`, `Stores.Plan`): the settings folder (project.json, the per-user profiles, cache, trash) instead of `<root>/.bugdesk`. A host can point it at a folder of its own. Two gaps stop that being a contract:

1. A legacy root `bugdesk.json` still wins over the configured folder (`Stores.Roster`), so a checkout that has one is still written.
2. `GitService.Others()` adds the settings folder to its `git status` pathspec. A folder outside the repository makes git fail ("outside repository"), and the Changes pane then loses every non-record change it should name.

The change is generic and opt-in: a project without `config` behaves exactly as today.

## Acceptance criteria

- [ ] A project with `config = '<folder>'` in `projects.toml` reads and writes its shared settings at `<folder>/project.json`, even when the checkout has a legacy root `bugdesk.json` or a `.bugdesk/project.json`; neither checkout file is read or written for that project
- [ ] A project without `config` is unchanged: `.bugdesk/project.json`, and a legacy root `bugdesk.json` still wins over it
- [ ] With the settings folder outside the repository, the Changes pane still names the non-record changes in the store folders (`GitService.Others()` leaves a folder outside the repo out of its pathspec)
- [ ] `GET /api/project` reports the resolved `path` (already does), so a host can check which file is in force
- [ ] README *Projects* documents `config` (and `attachments`) as per-project keys, and *Embedding BugDesk* names `config` as the way a host keeps a project's settings out of the checkout
- [ ] A test (`npm run test:server`, runs the built server; not part of `npm test`, which never invokes dotnet) covers: config outside the checkout with a legacy `bugdesk.json` and a tracked `.bugdesk/project.json` present → a roster write lands in the folder and `git status` in the checkout stays clean; the same project without `config` still writes the legacy file

## History

- 2026-10-21 · norman_agent · status: draft -> refined
- 2026-10-21 · norman_agent · status: refined -> in-progress
- 2026-10-21 · norman_agent · assignee: -> norman_agent

## Comments

### 2026-10-21T06:00Z · norman_agent

Filed for AI Desk STORY-0151 (BugDesk's configuration lives only in AI Desk). Refined: 6 criteria, 2 points, parented to EPIC-0051 (embedding). Related host-contract drafts: STORY-0052 (embed contract), STORY-0058 (trusted user header), STORY-0059 (host shared secret). Claimed by norman_agent; built on branch `p1c-config`.
