---
id: 7
type: story
title: "Lineage generated automatically from ETL, and at column level"
status: draft
parent: 1
phase:
assignee:
reporter: norman
points:
subsystem: governance
labels: [tables, governance, blocked-by-etl]
links: []
created: 2026-09-23
updated: 2026-09-23T19:01Z
---

## Description

Lineage today is DERIVED (grants, product inclusion) plus DECLARED by hand. The product owner's
direction: *"we will also link this to our ETL feature, so that the lineage graph is created
automatically."* ETL is phase 9 and not built; the `source = 'etl'` rows and their edit refusal are
built for a writer that does not exist yet.

Also: there is no column-level lineage, so "where does this column come from" cannot be answered.

## Acceptance criteria

_(not refined yet)_
