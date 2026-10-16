---
id: 50
type: story
title: "Duplicate, won't fix and the other built-in actions are configurable flows"
status: draft
parent: 17
phase:
assignee:
reporter: norman
due:
points:
subsystem: workflow
labels: []
links: []
created: 2026-10-16
updated: 2026-10-16T06:30Z
---

## Description

Review of workflow coverage on 2026-10-16:

**Modelled as configurable moves and actions:** the bug moves (Start
investigation, Hand to testing, Close, Back to open, Back to investigation,
Reopen, Move to <custom status>), the backlog ladders (Advance, Back, Reopen,
Drop, Restore to draft, custom statuses), custom actions, mass actions and
named flows. The flow nodes are start, end, condition, require-message, prompt,
set-field, clear-field, add-comment and set-status.

**Built in, but not configurable:**

- **Mark as duplicate** already exists as one step: "Mark as duplicate and
  close" for bugs and "Mark as duplicate and drop" for backlog items. Each adds
  `duplicates <target>`, closes or drops the record, comments on it and leaves a
  courtesy comment on the master (`POST /api/bugs/{id}/duplicate-of`,
  `/api/backlog/{id}/duplicate-of`). It is hard-coded, though. It can't be
  changed, and a flow can't rebuild it, because **no flow node can add a link**.
- Convert (bug <-> backlog) and Delete are also hard-coded.

**Missing:**

- **Resolutions:** won't fix, cannot reproduce, not a bug, works as designed. A
  bug can only be "closed", and the reason exists only in the comment. One
  option is a `resolution` field set by close-type actions; another is custom
  finished statuses.
- **Unblock** as an action (today it is only a custom status's "Back to ...").
- **Block for backlog types** (only the bug types have `blocked` configured).
- **Reassign / hand to** as a first-class action with a person picker.
- **Split** a record into several.
- **Reopen with a reason** for backlog items (a message is required for bugs
  only).

Proposed scope:

1. A flow node that adds a link (`add-link`, verb plus a target picked by a
   prompt).
2. Duplicate as a default action built from that node, which a project can
   edit.
3. A resolution field, or a documented custom-status recipe, for won't fix,
   cannot reproduce and similar outcomes.

## Acceptance criteria

_(not refined yet)_

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request ("did we really cover them all? ... What about mark as duplicate and done?"). Duplicate-and-close/drop does exist, but it is hard-coded, and a flow cannot express it because no node adds a link. The gaps are listed above. In draft until norman picks the scope.
