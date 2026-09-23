---
id: 9
type: story
title: "Collections: drag-and-drop filing and server-side filtering"
status: draft
parent: 1
phase:
assignee:
reporter: norman
points:
subsystem: governance
labels: [tables, governance]
links: [relates-to BUG-0011]
created: 2026-09-23
updated: 2026-09-23T19:01Z
---

## Description

Follow-up to BUG-0011 (collections navigator beside the registry). Filing a product is right-click →
"File in…" only; dragging a row onto a folder would be the expected gesture. Folder filtering also
runs in the browser over the loaded page (the registry's limit is 200), so a large catalogue would
narrow only what was fetched; `GET /governance/products` should take a collection filter that
includes descendants.

## Acceptance criteria

_(not refined yet)_
