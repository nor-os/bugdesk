---
id: 58
type: story
title: "A host can pass the signed-in user to an embedded or proxied BugDesk (trusted user header)"
status: review
parent: 51
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: hosting
labels: [embedding, identity]
links: [relates-to 59]
created: 2026-10-20
updated: 2026-10-21T19:20Z
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
- 2026-10-21 · norman_agent · status: refined -> in-progress
- 2026-10-21 · norman_agent · assignee: -> norman_agent
- 2026-10-21 · norman_agent · status: in-progress -> review
- 2026-10-21 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-20T18:40Z · norman_agent

Filed from AI Desk phase 1b planning (norman's change requests of 2026-10-20). Draft and optional; left for norman to decide and refine.

### 2026-10-20T23:37Z · norman_agent

Update from the AI Desk phase 1b build: AI Desk did not rewrite `actor` / `author` / `reporter` in its proxy after all, so every write made through AI Desk (embedded or standalone) is recorded as the rig's user (`norman`), not the signed-in user. This story is now the follow-up for per-user attribution; it pairs with STORY-0059 (shared secret on the sidecar port).

### 2026-10-21T18:06Z · norman_agent

Refined (norman gave the go 2026-10-21): 7 acceptance criteria, 5 points, parented to EPIC-0051, `relates-to 59`. Scope is BugDesk's side only: an opt-in header, honoured on loopback only, that sets the per-request user for `/api/config`, write attribution and the per-user profile (filters, settings). Added the unhappy paths the description did not spell out: non-loopback listen (header ignored, warned at start-up) and a missing or empty header (falls back to the process user). AI Desk's side (setting the header in its proxy from the signed-in user and stripping incoming copies) belongs in AI Desk's backlog; it is the gap reported in AI Desk STORY-0124 (`../aidesk/backlog/STORY-0124.md`) and STORY-0136. STORY-0059 (shared secret on the sidecar port) is not a precondition for this story, but without it any local process can name any user, so the two should ship together for a host that relies on the attribution.

### 2026-10-21T19:20Z · norman_agent

Built and merged into local main; handed back for review. All 7 criteria are covered by `scripts/test-server-identity.mjs` (12 cases); ticking them is yours.

- **Commits:** `4764233` (the change: `server/Program.cs`, `server/Stores.cs`, `server/UserConfig.cs`, README *Behind a host's sign-in*, CHANGELOG Unreleased/Added, new `scripts/test-server-identity.mjs`, `test:server` in package.json) and `3be7d89` (review fixes), merged with `--no-ff` as `1c30dc5`. With `BUGDESK_TRUSTED_USER_HEADER=X-AIDesk-User` and every listen address loopback, a request carrying the header is that user's: `/api/config`, comment author, `## History` actor, default reporter and assignee, and their own `user-<key>.json` / `state-<key>/`. Not loopback: ignored, one warning at start-up naming the setting. Missing or empty header: the process user. Over 128 characters, a control character or two copies: 400. `POST /api/config/user` as a header user: 409.
- **Review fixes in `3be7d89`:** names up to 128 characters (the longest AI Desk's `LocalDevUserContext.Sanitize` produces; the 60-character limit of BugDesk's own name prompt is unchanged); header names are exact (`oidc_x` and `oidc-x` are two users: a name that is its own slug keeps the plain profile key, any other gets `slug--<12 hex of SHA-256>`, agent `<name>_agent`); `Req.AsProcess` keeps a header user out of `projects.toml [user]` for stores opened later in the request (tracker, other projects); the non-loopback test listens on a Unix socket, nothing on the LAN.
- **Merge conflicts with STORY-0059** (`063b673`) in `Program.cs`, `package.json`, CHANGELOG, resolved keeping both: host-secret middleware first, then the trusted-user header, so the header is only read from requests that came through the host; `test:server` runs config, host-secret and identity. README *Behind a host's sign-in* now names `BUGDESK_HOST_SECRET` instead of "STORY-0059".
- **Tests on main after the merge:** `dotnet build server -c Release` 0 warnings; `npm run test:server` 6/6 (config), 9/9 (host secret), 12/12 (identity); `npm test` exit 0 with `NODE_OPTIONS=--experimental-require-module` on node 22.11 (225, 35, 60, 218, 58, 14, 8, 17, 16 passed). The builder also checked that removing `Req.AsProcess()` fails one identity case.
- **Not pushed:** local main carries `7240989` (Dashboards), which is not ours, so main stays local as instructed.
- **Unmet / your call:** a header user is **not** added to the roster (`collaborators`) automatically, since that would rewrite the shared settings per request; it is documented, and their records are still filed under their name. Decide whether you want auto-adding. How `IsLoopbackAddress` treats `0.0.0.0` / `*` / `+` is checked by review only (no C# unit-test project; the test covers "not loopback" with a Unix socket).
- **Review notes (low, not fixed):** the identity test's Unix socket lives under `os.tmpdir()`, so a long `TMPDIR` pushes it past the 108-character limit and the script aborts (passes with the default `/tmp`); a 128-character non-ASCII name that is its own slug can exceed the 255-byte file-name limit for `user-<slug>.json` (500 on save; AI Desk's names are ASCII-only, so only another host can hit this); `Profiles()` now lists header users' profiles in the unconfigured process user's first-run "you again?" list.
- **AI Desk side (not merged by me):** branch `1b-bugdesk-0058-aidesk` in aidesk (`0922e69` the proxy sets `X-AIDesk-User` from the signed-in user and drops a browser's copy; `72d6419` documents and tests the 128-character limit), merges cleanly onto aidesk `origin/main`; builder's `dotnet test server.tests` 426 passed. Merge it together with this one: AI Desk can send names longer than BugDesk's old 60-character limit.
- **norman:** push bugdesk main (with `7240989`), merge/push the AI Desk branch (it starts the sidecar with `BUGDESK_TRUSTED_USER_HEADER=X-AIDesk-User`; STORY-0059's `1b-bugdesk-0059-aidesk` too), then restart AI Desk on 8780 so the sidecar on 8781 picks both up.
