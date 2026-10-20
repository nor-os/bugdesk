---
id: 58
type: story
title: "A host can pass the signed-in user to an embedded or proxied BugDesk (trusted user header)"
status: draft
parent: 51
phase:
assignee:
reporter: norman
due:
points:
subsystem: hosting
labels: [embedding, identity]
links: []
created: 2026-10-20
updated: 2026-10-20T23:37Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk behind its own proxy and sign-in ("Sign in with Tables", AI Desk STORY-0005, `../aidesk/backlog/STORY-0005.md`), embedded in its tiles and standalone under `/bugdesk/` (AI Desk STORY-0124). BugDesk has one identity per process (`projects.toml [user]` or `BUGDESK_USER`, `Users.HumanAuthor`), so every request through the host acts as the host's service identity.

Proposal: an opt-in setting (for example `BUGDESK_TRUSTED_USER_HEADER=X-AIDesk-User`), honoured only while BugDesk listens on loopback, makes BugDesk take the per-request user from that header: `HumanAuthor`, `/api/config`, and the per-user filters and settings profile resolve per request. The host strips any incoming copy of the header and sets its own.

**Optional.** AI Desk works without it (decision of 2026-10-20: no BugDesk changes for AI Desk phase 1b): its proxy can rewrite `actor` / `author` / `reporter` on writes. What stays wrong without it are the per-user views — "On me", "Needs my reply" and saved filters stay on the service identity.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-20T18:40Z · norman_agent

Filed from AI Desk phase 1b planning (norman's change requests of 2026-10-20). Draft and optional; left for norman to decide and refine.

### 2026-10-20T23:37Z · norman_agent

Update from the AI Desk phase 1b build: AI Desk did not rewrite `actor` / `author` / `reporter` in its proxy after all, so every write made through AI Desk (embedded or standalone) is recorded as the rig's user (`norman`), not the signed-in user. This story is now the follow-up for per-user attribution; it pairs with STORY-0059 (shared secret on the sidecar port).
