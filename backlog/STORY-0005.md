---
id: 5
type: story
title: "Alerts"
status: draft
parent: 17
phase:
assignee:
reporter: norman
due:
points:
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-06T01:55Z
---

## Description

Use SSE to send alerts for tickets. Alerts must be configurable on any attribute with the conditions we also allow for filters. Of course, this only works while bugdesk is active. 

Alerts should be shown where console currently is shown and optionally as toasts which optionally have to be closed with x -otherwise they would stack up to n toasts and the n+1 toasts just collapses to x alerts. 

We also need to differentiate between warnings, info and alert - but - I think we already have a good template for this in flexdesk? We're using it in Audit logs in ../Tables

## Acceptance criteria

_(not refined yet)_
