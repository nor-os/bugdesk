---
id: 11
type: story
title: "Allow export permission inside a product grant"
status: draft
parent: 1
phase:
assignee:
reporter: norman
points:
subsystem: governance
labels: [tables, governance]
links: []
created: 2026-09-23
updated: 2026-09-23T19:01Z
---

## Description

`table:row:export` is deliberately absent from what a product confers: it is declared unsubtyped, so
granting it would confer export over EVERY table in the contributing project. The fix is making the
key subtyped at its declaration (a file governance does not own), after which a product can hand out
export on exactly its own tables. Until then the honest bundle is the narrow one.

## Acceptance criteria

_(not refined yet)_
