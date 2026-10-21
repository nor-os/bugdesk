---
id: 58
type: story
title: "A host can pass the signed-in user to an embedded or proxied BugDesk (trusted user header)"
status: refined
parent: 51
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: hosting
labels: [embedding, identity]
links: [relates-to 59]
created: 2026-10-20
updated: 2026-10-21T18:06Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk behind its own proxy and sign-in ("Sign in with Tables", AI Desk STORY-0005, `../aidesk/backlog/STORY-0005.md`), embedded in its tiles and standalone under `/bugdesk/` (AI Desk STORY-0124). BugDesk has one identity per process (`projects.toml [user]` or `BUGDESK_USER`, `Users.HumanAuthor`), so every request through the host acts as the host's service identity.

Proposal: an opt-in setting (for example `BUGDESK_TRUSTED_USER_HEADER=X-AIDesk-User`), honoured only while BugDesk listens on loopback, makes BugDesk take the per-request user from that header: `HumanAuthor`, `/api/config`, and the per-user filters and settings profile resolve per request. The host strips any incoming copy of the header and sets its own.

**Optional.** AI Desk works without it (decision of 2026-10-20: no BugDesk changes for AI Desk phase 1b): its proxy can rewrite `actor` / `author` / `reporter` on writes. What stays wrong without it are the per-user views — "On me", "Needs my reply" and saved filters stay on the service identity.

## Acceptance criteria

- [ ] With `BUGDESK_TRUSTED_USER_HEADER` unset, nothing changes: a request that carries an `X-AIDesk-User` (or any other) header is still attributed to the process user (`projects.toml [user]` / `BUGDESK_USER`)
- [ ] With the setting on and BugDesk listening on loopback only, `/api/config` returns the header's user as `humanAuthor` (and `<name>_agent` as `agentAuthor` unless that user's profile names another), per request
- [ ] With the setting on, a comment, status change, assignment and new bug or backlog item made through the UI are recorded under the header's user: comment author, `## History` actor and default `reporter`
- [ ] Two browsers sending two different header users at the same time each get their own "On me", "Needs my reply" and saved filters; saving a filter or setting as one changes neither the other's nor the process user's profile
- [ ] With the setting on but BugDesk listening on a non-loopback address, the header is not honoured and BugDesk says so once at start-up, naming the setting
- [ ] With the setting on, a request without the header (or with an empty one) falls back to the process user, never to a blank author or an error
- [ ] The setting, the loopback-only rule and the host's duty to strip any incoming copy of the header are documented in the README and covered by server tests

## History

- 2026-10-21 · norman_agent · status: draft -> refined

## Comments

### 2026-10-20T18:40Z · norman_agent

Filed from AI Desk phase 1b planning (norman's change requests of 2026-10-20). Draft and optional; left for norman to decide and refine.

### 2026-10-20T23:37Z · norman_agent

Update from the AI Desk phase 1b build: AI Desk did not rewrite `actor` / `author` / `reporter` in its proxy after all, so every write made through AI Desk (embedded or standalone) is recorded as the rig's user (`norman`), not the signed-in user. This story is now the follow-up for per-user attribution; it pairs with STORY-0059 (shared secret on the sidecar port).

### 2026-10-21T18:06Z · norman_agent

Refined (norman gave the go 2026-10-21): 7 acceptance criteria, 5 points, parented to EPIC-0051, `relates-to 59`. Scope is BugDesk's side only: an opt-in header, honoured on loopback only, that sets the per-request user for `/api/config`, write attribution and the per-user profile (filters, settings). Added the unhappy paths the description did not spell out: non-loopback listen (header ignored, warned at start-up) and a missing or empty header (falls back to the process user). AI Desk's side (setting the header in its proxy from the signed-in user and stripping incoming copies) belongs in AI Desk's backlog; it is the gap reported in AI Desk STORY-0124 (`../aidesk/backlog/STORY-0124.md`) and STORY-0136. STORY-0059 (shared secret on the sidecar port) is not a precondition for this story, but without it any local process can name any user, so the two should ship together for a host that relies on the attribution.
