---
id: 6
type: story
title: "Configurable Commit and Save Settings"
status: draft
parent: 19
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

Git Commit: Should be configurable if done after a change / save. Same for Push.
Add a changelog in the bottom panel, having also dedicated commit and push options and buttons for the changes. 
../EcoSim has integrated git I think - ../EcoAgent probably too - in an improved version

Add also the option to always auto-save. In configurable intervals - or in a debounced timer controlled mechanism with exponential backoff. 
Adjust available buttons and texts (when we save) accordingly. Also the Saved-Status.

_Scope: auto-save (the second paragraph) was split out into STORY-0020; this story keeps commit, push and the changes panel._

## Acceptance criteria

_(not refined yet)_
