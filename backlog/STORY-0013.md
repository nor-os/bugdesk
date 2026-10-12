---
id: 13
type: story
title: "Define custom fields per record type"
status: review
parent: 3
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-12T13:40Z
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

- [x] In settings, a project can add, rename, reorder and remove custom fields for any record type: each bug type, each backlog type and tracker tickets
- [x] A field can be text, number, date, yes/no or choice; a choice field has an editable list of values, and any field can be marked required
- [x] The schema is saved in `.bugdesk/project.json` and is the same for everyone who pulls the repo; a reload or another user's BugDesk picks it up without a restart
- [x] A field name that clashes with a built-in field (`status`, `title`, ...) or another custom field on the same type is refused, with a message naming the clash
- [x] Removing a field asks for confirmation and leaves the values already in records untouched in the files
- [x] A missing or malformed schema in `project.json` means "no custom fields" with a visible warning, not a broken page

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0003. "All record types" covers bug,
regression and chore, project, epic, story and task, and tracker tickets, as
you answered. The schema lives in `project.json`, as agreed. I added two unhappy
paths: a name clash with a built-in field, and a broken schema file.

### 2026-10-12T13:40Z · norman_agent (status: in-progress -> review)

Built in 04b5a11, with the rest of EPIC-0003's base. All six criteria are met.

- **Settings › General › Project › Record types…** opens the editor, a window
  modelled on Tables' Create table dialog. The record types are listed down
  the left: Bug, Regression, Chore, then each backlog type, and each ticket
  type in a tracker. The chosen type shows one row per field: name, label,
  type (text, number, date, yes/no, choice), Required, ↑/↓ to reorder, × to
  remove. A choice field gets its own row for its values.
- **Storage:** `schema` in `.bugdesk/project.json`, keyed by store and then
  type, because a Chore bug and a backlog task are different types. The UI
  reads it with the config, so a pulled change shows on the next reload. No
  restart is needed.
- **Refused, with every problem listed, and the window stays open:** a name
  that is a built-in field (`status`, `due`, …), a field name used twice on
  one type, a choice with no values. The server checks the same rules, so a
  hand-edited `project.json` cannot sneak past them.
- **Renaming:** a saved field keeps its *name* (records hold it as a key), and
  the *label* is what you rename.
- **Removing** asks first and says the values stay in the files.
- **A malformed schema** means no custom fields. The editor shows a warning
  naming each problem, and the status bar says so at boot.

Checked in headless Edge on a scratch copy of the store: added Customer (text)
and Tier (choice: gold, silver) and a status to Story, and saved. A field
called `due` was refused with the message, and `project.json` came out as
expected. DOM 150/150, UI 218/218, tracker 34/34.
