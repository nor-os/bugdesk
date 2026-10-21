---
id: 59
type: story
title: "A host can require a shared secret on every request to a loopback BugDesk"
status: review
parent: 51
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: hosting
labels: [embedding, security]
links: [relates-to 58]
created: 2026-10-20
updated: 2026-10-21T19:10Z
---

## Description

AI Desk (`../aidesk`) runs a managed BugDesk as a sidecar on a loopback port and puts its own sign-in ("Sign in with Tables", AI Desk STORY-0005, `../aidesk/backlog/STORY-0005.md`) and permission checks in front of it through its proxy. The sidecar port itself has no sign-in, so any local process on the machine can read and write records there and skip AI Desk's checks. AI Desk documents this as a known gap (AI Desk phase 1b security review, 2026-10-20).

Proposal: an opt-in setting (for example `BUGDESK_HOST_SECRET`). When it is set, BugDesk answers only requests that carry the secret in a header (for example `X-BugDesk-Host-Secret`) and refuses every other request with 401. The host generates the secret, passes it to the sidecar at start, adds the header in its proxy, and strips any incoming copy. With the setting unset, nothing changes.

Related: STORY-0058 (trusted user header), which only makes sense when the port can be trusted.

## Acceptance criteria

- [x] With `BUGDESK_HOST_SECRET` unset (or empty), nothing changes: every request is answered exactly as before, with or without an `X-BugDesk-Host-Secret` header
- [x] With the setting on, every request without the header, or with a wrong value, gets 401 and no data: API reads and writes, `/api/events`, and the UI's own pages and scripts alike
- [x] With the setting on, a request carrying the right secret in `X-BugDesk-Host-Secret` behaves exactly as with the setting unset, including the `/api/events` stream
- [x] The secret never appears in BugDesk's responses, in `/api/config`, or in its log; at start-up BugDesk says once that host-secret mode is on, without the value
- [x] The setting, the header name, and the host's duties (generate the secret, pass it to BugDesk at start, add the header in its proxy, strip any incoming copy) are documented in the README and covered by server tests

## History

- 2026-10-21 · norman_agent · status: draft -> refined
- 2026-10-21 · norman_agent · status: refined -> in-progress
- 2026-10-21 · norman_agent · assignee: -> norman_agent
- 2026-10-21 · norman_agent · status: in-progress -> review
- 2026-10-21 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-20T23:37Z · norman_agent

Filed as a follow-up from AI Desk phase 1b (security review, minor finding: the sidecar port has no sign-in). Draft; left for norman to decide and refine.

### 2026-10-21T18:08Z · norman_agent

Refined (norman gave the go 2026-10-21): 5 acceptance criteria, 3 points, parented to EPIC-0051, `relates-to 58`. Scope is BugDesk's side only: an opt-in shared secret that every request must carry once it is set, the UI's static files and the `/api/events` stream included, so the port answers nothing useful to a local process without it. Added what the description did not spell out: a wrong secret is treated like a missing one, and the secret never shows up in responses, `/api/config` or the log. Comparing the secret in constant time is an implementation note for the server tests, not a criterion. AI Desk's side (generating the secret, passing it to the sidecar, adding the header in its proxy and in its readiness probe, which calls `GET /api/projects`, and stripping incoming copies) belongs in AI Desk's backlog. Pairs with STORY-0058 (trusted user header): without this story any local process can name any user there.

### 2026-10-21T19:10Z · norman_agent

Built and merged into local main; handed back for review. All 5 criteria verified by the server tests below.

- **Commits:** `f5e1fe7` (the change: `server/Program.cs`, README *Embedding BugDesk*, CHANGELOG Unreleased/Added, new `scripts/test-server-host-secret.mjs`, `test:server` in package.json), merged with `--no-ff` as `063b673`. With `BUGDESK_HOST_SECRET` set, a middleware FIRST in the pipeline answers every request without `X-BugDesk-Host-Secret` (or with a wrong, empty or duplicated value) with 401 and only `{ok:false,error}`: API, `/api/events`, UI pages and scripts, `/attachments`. Compared as SHA-256 hashes in constant time; the header is removed from the request once checked and the variable from BugDesk's own environment once read, so git and its hooks do not inherit it. Logged once ("host-secret mode is on", header name only). Unset, empty or blank: unchanged.
- **Not pushed:** local main carries `7240989` (Dashboards), which is not ours, so main stays local as instructed. norman pushes it with that commit.
- **Tests on main after the merge:** `npm run test:server` 6/6 (config) and 9/9 (host secret: on, empty, blank, unset); `npm test` exit 0 with `NODE_OPTIONS=--experimental-require-module` on node 22.11 (225, 35, 60, 218, 58, 14, 8, 17, 16 passed; eslint 0 errors, 81 old warnings, none in the new file).
- **Review notes (low, not fixed):** no test sends two copies of the header (the code refuses it, `given.Count == 1`); the variable is dropped from the environment at the middleware, after the stores are built, and no child process starts before that.
- **Shortcut / out of scope:** a same-user process can still read the secret from `/proc/<pid>/environ`; the secret keeps out other users and web pages. Documented on the AI Desk side.
- **AI Desk side (not merged by me):** branch `1b-bugdesk-0059-aidesk` (`a1e3f30`) in aidesk: secret generated per sidecar start, passed in the environment, sent by the readiness probe, the sidecar client (event stream included) and the proxy, which also drops a browser's copy; `dotnet test` 432 passed. It has no AI Desk backlog record yet (file one, or update STORY-0124's known-gap note). Either side can land first.
- **norman:** push bugdesk main (with `7240989`), merge/push the AI Desk branch, then restart AI Desk on 8780 so the sidecar on 8781 starts with the secret; only then is the port closed. STORY-0058 (trusted user header) will conflict lightly in README/CHANGELOG/Program.cs; its check sits after this one, so the user header is only read from requests that came through the host.
