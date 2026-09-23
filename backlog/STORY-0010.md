---
id: 10
type: story
title: "Share a data product outside the deployment"
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

Doc 21 § Sharing beyond the deployment: currently internal only, and **the one remaining open
question in that document**. Answering it is the product owner's call. If the answer is yes, the
shape is "a data product granted to an external principal", and the work is five items: an external
principal type, an egress mechanism (external SQL endpoint or a Parquet/Delta export), a
classification gate barring confidential/restricted products, egress audit, and revocation that
does not promise to recall data already copied.

## Acceptance criteria

_(not refined yet)_
