---
id: 3
type: story
title: "Warn when a column drop or retype breaks a data product contract"
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

**The largest real gap in the feature** (docs/23). `api/ddl/dependencies.py` resolves dependents
across `meta` in the PROJECT database, while a product's sources live in the CONTROL database. So
dropping or retyping a column today lists no product that promises it; the drift only surfaces when
somebody next runs the contract check.

Needs either a cross-database lookup or a control-plane call from the DDL path. Drift stays
reported, not enforced (docs/21 § Contracts: a second veto in the governance ledger would refuse a
DDL change for a reason the change dialog cannot explain). The change sheet should name the
affected products and their owners.

## Acceptance criteria

_(not refined yet)_
