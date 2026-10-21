---
id: 59
type: story
title: "A host can require a shared secret on every request to a loopback BugDesk"
status: refined
parent: 51
phase:
assignee:
reporter: norman
due:
points: 3
subsystem: hosting
labels: [embedding, security]
links: [relates-to 58]
created: 2026-10-20
updated: 2026-10-21T18:08Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk as a sidecar on a loopback port and puts its own sign-in ("Sign in with Tables", AI Desk STORY-0005, `../aidesk/backlog/STORY-0005.md`) and permission checks in front of it through its proxy. The sidecar port itself has no sign-in, so any local process on the machine can read and write records there and skip AI Desk's checks. AI Desk documents this as a known gap (AI Desk phase 1b security review, 2026-10-20).

Proposal: an opt-in setting (for example `BUGDESK_HOST_SECRET`). When it is set, BugDesk answers only requests that carry the secret in a header (for example `X-BugDesk-Host-Secret`) and refuses every other request with 401. The host generates the secret, passes it to the sidecar at start, adds the header in its proxy, and strips any incoming copy. With the setting unset, nothing changes.

Related: STORY-0058 (trusted user header), which only makes sense when the port can be trusted.

## Acceptance criteria

- [ ] With `BUGDESK_HOST_SECRET` unset (or empty), nothing changes: every request is answered exactly as before, with or without an `X-BugDesk-Host-Secret` header
- [ ] With the setting on, every request without the header, or with a wrong value, gets 401 and no data: API reads and writes, `/api/events`, and the UI's own pages and scripts alike
- [ ] With the setting on, a request carrying the right secret in `X-BugDesk-Host-Secret` behaves exactly as with the setting unset, including the `/api/events` stream
- [ ] The secret never appears in BugDesk's responses, in `/api/config`, or in its log; at start-up BugDesk says once that host-secret mode is on, without the value
- [ ] The setting, the header name, and the host's duties (generate the secret, pass it to BugDesk at start, add the header in its proxy, strip any incoming copy) are documented in the README and covered by server tests

## History

- 2026-10-21 · norman_agent · status: draft -> refined

## Comments

### 2026-10-20T23:37Z · norman_agent

Filed as a follow-up from AI Desk phase 1b (security review, minor finding: the sidecar port has no sign-in). Draft; left for norman to decide and refine.

### 2026-10-21T18:08Z · norman_agent

Refined (norman gave the go 2026-10-21): 5 acceptance criteria, 3 points, parented to EPIC-0051, `relates-to 58`. Scope is BugDesk's side only: an opt-in shared secret that every request must carry once it is set, the UI's static files and the `/api/events` stream included, so the port answers nothing useful to a local process without it. Added what the description did not spell out: a wrong secret is treated like a missing one, and the secret never shows up in responses, `/api/config` or the log. Comparing the secret in constant time is an implementation note for the server tests, not a criterion. AI Desk's side (generating the secret, passing it to the sidecar, adding the header in its proxy and in its readiness probe, which calls `GET /api/projects`, and stripping incoming copies) belongs in AI Desk's backlog. Pairs with STORY-0058 (trusted user header): without this story any local process can name any user there.
