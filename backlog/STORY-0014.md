---
id: 14
type: story
title: "Show and edit custom fields on records"
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

Once a type has custom fields (STORY-0013), every place a record of that type is
read or written shows them: the record page, the new-record form and the edit
form. Values are checked against the schema, so a required field must be
filled and a choice field only takes one of its values. Records written before a
field existed still open; the field is simply empty.

## Acceptance criteria

- [x] A record of a type with custom fields shows them on its page, each in a control that suits its type (date picker, choice dropdown, yes/no toggle)
- [x] The new-record form and the edit form include the custom fields; saving writes each value as its own frontmatter key in the record file
- [x] Saving with a required field empty, or a value outside a choice field's list, is refused with a message naming the field, and nothing is written
- [x] A record written before a field existed opens and saves normally; the field shows as empty, and no key is added to the file unless a value is set
- [x] A value in a file for a field the schema no longer has is kept on save, not dropped
- [x] An agent editing the file by hand (the /bugs and /backlog skills) can set a custom field as a plain frontmatter line, and the UI shows it

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0003. The last two criteria protect
the file-first design: unknown keys survive a UI save, and a hand-written
frontmatter line counts as a value.

### 2026-10-12T13:40Z · norman_agent (status: in-progress -> review)

Built in 04b5a11. All six criteria are met.

- **Where the fields show:** the bug page, the backlog/ticket item page and
  New item each have a **Fields** section with the type's own fields. It
  redraws when the Type changes. Controls by type: date picker, number box,
  the app's dropdown for a choice, Yes / No / — for yes/no.
- **Saving:** sends only the fields that changed, each as its own frontmatter
  line after `links:` (`env: prod`). Text is quoted, so a colon in a value
  survives.
- **Refused, with the field named:** a required field left empty on a new
  record, a value outside a choice list, a number that is not a number. The
  bridge checks again, and nothing is written when it refuses.
- **Older records:** a record written before the field existed opens with it
  empty and saves without gaining a key. A required field is only enforced
  when you create a record or clear the field.
- **Values the schema no longer names** show read-only, marked "not in the
  schema", and are kept on save.
- **Agents:** the /bugs, /backlog and /tracker skills now have a "Custom
  fields and statuses" section. A field is a plain frontmatter line, and the
  UI shows a hand-written one.

Checked in Edge: set a date on a bug and saved it, then saved an old bug
untouched (no key added). Set a text and a choice on a story. New bug without
the required Environment was refused with "Environment is required." All
files looked right afterwards.
