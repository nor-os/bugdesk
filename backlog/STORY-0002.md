---
id: 2
type: story
title: "Request access to a data product, with approval gated on classification"
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

Today a product is granted directly by someone who already holds the authority (rule G3); a
justification is recorded, but there is **no request route and no approver**. A person who finds a
product in the catalogue has nothing to press.

What doc 21 already designs: public/internal products may be self-service, and anything
confidential or restricted requires the owner's approval, with the request and its reason as the
audit record. `request_policy` was dropped in `0012` precisely because nothing read it; it comes
back with its reader.

Open decision: build a small request queue now, or wait for the approval-gate workflow in phase 10
(`ApprovalChainWorkflow`). Includes a "Request access" action on a product page for a non-holder.

## Acceptance criteria

_(not refined yet)_
