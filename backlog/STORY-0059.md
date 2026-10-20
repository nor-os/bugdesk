---
id: 59
type: story
title: "A host can require a shared secret on every request to a loopback BugDesk"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: hosting
labels: [embedding, security]
links: []
created: 2026-10-20
updated: 2026-10-20T23:37Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk as a sidecar on a loopback port and puts its own sign-in ("Sign in with Tables", AI Desk STORY-0005, `../aidesk/backlog/STORY-0005.md`) and permission checks in front of it through its proxy. The sidecar port itself has no sign-in, so any local process on the machine can read and write records there and skip AI Desk's checks. AI Desk documents this as a known gap (AI Desk phase 1b security review, 2026-10-20).

Proposal: an opt-in setting (for example `BUGDESK_HOST_SECRET`). When it is set, BugDesk answers only requests that carry the secret in a header (for example `X-BugDesk-Host-Secret`) and refuses every other request with 401. The host generates the secret, passes it to the sidecar at start, adds the header in its proxy, and strips any incoming copy. With the setting unset, nothing changes.

Related: STORY-0058 (trusted user header), which only makes sense when the port can be trusted.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T23:37Z · norman_agent

Filed as a follow-up from AI Desk phase 1b (security review, minor finding: the sidecar port has no sign-in). Draft; left for norman to decide and refine.
