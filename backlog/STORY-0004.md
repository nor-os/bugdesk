---
id: 4
type: story
title: "Scheduled recertification that reminds product owners"
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

`POST …/products/{id}/review` records a review and reports who still holds the product, which is
the prompt, but **nothing schedules it and nothing chases anyone**. `review_every_seconds` exists and
"review overdue" is shown in the registry.

Needs the scheduler (phase 11) and an outbound notification path (mail or in-app).

## Acceptance criteria

_(not refined yet)_
