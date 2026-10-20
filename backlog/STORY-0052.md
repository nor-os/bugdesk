---
id: 52
type: story
title: "Ticketdesk modules take their API base and config from their own URL"
status: refined
parent: 51
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk, embedding]
links: []
created: 2026-10-20
updated: 2026-10-20T09:18Z
---

## Description

`ui/js/ticketdesk/instance.js` resolves the API relative to the DOCUMENT (`const API = 'api'`) and reads its
config from `window.__BUGDESK_CONFIG__`. Inside BugDesk that is right, because the page is served under
`/p/<name>/`. Inside another FlexDesk application (AI Desk, AI Desk STORY-0111,
`../aidesk/backlog/STORY-0111.md`) the document is that application's page, so every call goes to the wrong
server, and two projects cannot run side by side.

Derive the API base from the module's own URL (for the page's copy, `new URL('../../api', import.meta.url)`; the
tracker's copy keeps `/t/api`) and let a copy load its config from its own API when no page-wide config is
present. BugDesk's behaviour on its own pages does not change.

## Acceptance criteria

- [ ] Served from `/p/<name>/` and `/t/`, BugDesk behaves exactly as today, and the existing tests pass
- [ ] Importing `/p/<name>/js/ticketdesk/pages.js` from a page at another path sends every API call and the `/api/events` stream to `/p/<name>/api/`
- [ ] Two projects' modules imported into one page each talk to their own project and keep separate state
- [ ] Without `window.__BUGDESK_CONFIG__`, a copy loads its config from its own API before it renders
- [ ] The README has a section 'Embedding BugDesk' that names the entry point (`createTicketDeskContent`) and what the host provides (event bus, FlexDesk version, Material Symbols, tokens)
- [ ] A test imports the modules under a different document URL and checks the API base

## History

- 2026-10-20 · norman_agent · status: draft -> refined

## Comments

### 2026-10-20T09:18Z · norman_agent

Refined: 6 criteria, 5 points, parented to EPIC-0051. The unhappy path is covered by the first criterion: nothing changes for BugDesk's own pages.
