---
id: 13
type: story
title: "Define custom fields per record type"
status: draft
parent: 3
phase:
assignee:
reporter: norman
due:
points:
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:12Z
---

## Description

A project can add its own fields to any record type: bugs (bug, regression,
chore), backlog items (project, epic, story, task) and tracker tickets. The
settings dialog is modelled on Tables' CreateTable dialog
(`../Tables/web/js/dialogs/table_dialog.js`, `column_editor.js`): one row per
field, holding a name, a type and a required flag, plus settings per type.

Types: text, number, date, yes/no, and choice (an enum with a fixed list of
values). The schema is stored in the committed `.bugdesk/project.json`, so
everyone on the store shares it. Each record stores its values as extra
frontmatter keys.

## Acceptance criteria

_(not refined yet)_
