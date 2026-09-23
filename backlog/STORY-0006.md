---
id: 6
type: story
title: "Measure product SLAs instead of only recording them"
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

The contract's freshness SLO, availability target and support response are recorded and reported,
**never measured** (`api/governance/contract.py`). A product saying "fresh within 1h" is taken on
trust. Needs a definition of freshness per source (last write time, or a pipeline run from ETL)
and somewhere to show breaches.

## Acceptance criteria

_(not refined yet)_
