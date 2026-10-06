---
id: 22
type: story
title: "Retire BugDesk's modal fork for FlexDesk's"
status: draft
parent: 12
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: [flexdesk, tech-debt]
links: []
created: 2026-10-06
updated: 2026-10-06T01:55Z
---

## Description

`ui/js/ui/components/modal.js` is BugDesk's copy of FlexDesk's `modal.js`
(625 lines against 718 upstream; about 400 changed lines between them). It
provides the prompt and confirm dialogs used by settings, collaborators,
first run, the project switcher and the bug moves. As with STORY-0008: move
whatever BugDesk's copy has that FlexDesk lacks into FlexDesk, switch over, and
delete the copy.

## Acceptance criteria

_(not refined yet)_
