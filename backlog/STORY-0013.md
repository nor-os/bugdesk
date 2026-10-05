---
id: 13
type: story
title: "Define custom fields per record type"
status: refined
parent: 3
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:14Z
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

- [ ] In settings, a project can add, rename, reorder and remove custom fields for any record type: each bug type, each backlog type and tracker tickets
- [ ] A field can be text, number, date, yes/no or choice; a choice field has an editable list of values, and any field can be marked required
- [ ] The schema is saved in `.bugdesk/project.json` and is the same for everyone who pulls the repo; a reload or another user's BugDesk picks it up without a restart
- [ ] A field name that clashes with a built-in field (`status`, `title`, ...) or another custom field on the same type is refused, with a message naming the clash
- [ ] Removing a field asks for confirmation and leaves the values already in records untouched in the files
- [ ] A missing or malformed schema in `project.json` means "no custom fields" with a visible warning, not a broken page

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0003. "All record types" covers bug,
regression and chore, project, epic, story and task, and tracker tickets, as
you answered. The schema lives in `project.json`, as agreed. I added two unhappy
paths: a name clash with a built-in field, and a broken schema file.
