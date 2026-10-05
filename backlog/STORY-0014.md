---
id: 14
type: story
title: "Show and edit custom fields on records"
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

Once a type has custom fields (STORY-0013), every place a record of that type is
read or written shows them: the record page, the new-record form and the edit
form. Values are checked against the schema, so a required field must be
filled and a choice field only takes one of its values. Records written before a
field existed still open; the field is simply empty.

## Acceptance criteria

- [ ] A record of a type with custom fields shows them on its page, each in a control that suits its type (date picker, choice dropdown, yes/no toggle)
- [ ] The new-record form and the edit form include the custom fields; saving writes each value as its own frontmatter key in the record file
- [ ] Saving with a required field empty, or a value outside a choice field's list, is refused with a message naming the field, and nothing is written
- [ ] A record written before a field existed opens and saves normally; the field shows as empty, and no key is added to the file unless a value is set
- [ ] A value in a file for a field the schema no longer has is kept on save, not dropped
- [ ] An agent editing the file by hand (the /bugs and /backlog skills) can set a custom field as a plain frontmatter line, and the UI shows it

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0003. The last two criteria protect
the file-first design: unknown keys survive a UI save, and a hand-written
frontmatter line counts as a value.
