---
id: 7
type: story
title: "Ask who's working here, once"
status: done
parent: 6
phase:
assignee: agent
reporter: norman
points: 3
subsystem: config
labels: [multi-user]
links: []
created: 2026-09-03
updated: 2026-09-10
---

## Description

On a checkout that has never been used, BugDesk asks for a name before it
renders anything else, and writes it to a git-ignored per-user file beside the
store. It never asks again.

## Acceptance criteria

- [x] A first run blocks on the prompt — the name is resolved before any page renders
- [x] The answer lands in a directory that ignores itself in git
- [x] A second person on the same repo gets their own profile, not the first person's
- [x] `BUGDESK_HUMAN` still wins, and suppresses the prompt entirely

## History

- 2026-09-04 · reviewer · status: draft -> refined
- 2026-09-08 · agent · status: refined -> in-progress
- 2026-09-08 · agent · assignee: reviewer -> agent
- 2026-09-10 · agent · status: in-progress -> review
- 2026-09-10 · reviewer · status: review -> done

## Comments

### 2026-09-10 · agent

Blocking is the whole trick: the author names are resolved once at module-eval
time and baked into the filter expressions, so asking after boot would leave
every one of them holding the pre-answer default until a reload.
