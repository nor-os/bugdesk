---
id: 52
type: story
title: "Ticketdesk modules take their API base and config from their own URL"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, embedding]
links: []
created: 2026-10-20
updated: 2026-10-20T09:17Z
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

_(not refined yet)_

## History

## Comments
