---
id: 50
type: story
title: "Duplicate, won't fix and the other built-in actions are configurable flows"
status: in-progress
parent: 17
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: workflow
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T06:22Z
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

- [ ] A flow can add a link: the flow editor offers an "Add a link" step with a verb (one of the seven link verbs) and a target, and "Ask for input" can ask for "A record", which opens the record picker and gives later steps the picked record's reference and title.
- [ ] The link is saved in the same write as the rest of the move or action, added to the record's existing links (never replacing them). The step can leave a comment on the linked record; that comment is written after the record itself.
- [ ] A link step whose target is not a record, is the record itself, or names a record that does not exist is refused by the server, and nothing is written to either record.
- [ ] Settings › Workflow lists "Mark as duplicate and close" among each bug type's actions and "Mark as duplicate and drop" among each backlog type's actions. Each runs a flow built from those steps: pick the master, add `duplicates <master>`, set the resolution to duplicate, comment, then close or drop. A project can rename, change or remove it there, and the record pages and right-click menus then offer the changed version (or nothing).
- [ ] With nothing configured, Mark as duplicate does what it did before: one save links the record, closes the bug or drops the item, comments on it, and leaves the courtesy comment on the master. Cancelling the picker writes nothing.
- [ ] `POST /api/bugs/{id}/duplicate-of` and `POST /api/backlog/{id}/duplicate-of` still work as before, and now also set the resolution to duplicate.
- [ ] Bugs and backlog items have a `resolution` field (fixed, won't fix, cannot reproduce, not a bug, works as designed, duplicate), stored as one frontmatter line. Closing a bug, dropping an item, or moving either into a custom finished status asks for the resolution in the same dialog as the message (default: fixed for a bug, won't fix for a drop). Moving a backlog item to done does not ask. Reopening or restoring clears the resolution. If the move's flow sets or clears the resolution itself, nobody is asked.
- [ ] The resolution is shown and can be changed on the bug page and the item page, is a field in the bug and backlog filter editors, and flows can set it, clear it and test it with If … otherwise.
- [ ] The in-app help, README and CHANGELOG describe the link step, the default duplicate action and resolutions.

Out of scope (norman, 2026-10-17): unblock as an action, block for backlog types, reassign/hand-to as an action, split, and reopen-with-a-reason for backlog items. Convert and Delete stay hard-coded.

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee:  -> norman_agent

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request ("did we really cover them all? ... What about mark as duplicate and done?"). Duplicate-and-close/drop does exist, but it is hard-coded, and a flow cannot express it because no node adds a link. The gaps are listed above. In draft until norman picks the scope.

### 2026-10-17T06:22Z · norman_agent

Refined with norman's answers (2026-10-17). Scope is the three proposed items: (1) an `add-link` flow step, with the target picked by a prompt; (2) Duplicate rebuilt as a default, editable action made from that step (bugs: duplicate and close; backlog: duplicate and drop), keeping the courtesy comment on the master and the existing API endpoints; (3) a `resolution` field set by close-type moves (fixed, won't fix, cannot reproduce, not a bug, works as designed, duplicate), shown and filterable like other fields. Unblock, block for backlog, reassign, split and reopen-with-a-reason are out of scope. 9 criteria, 5 points. My decisions within that scope: moving a backlog item to done does not ask for a resolution, because done already says how it ended; the resolution is asked in the same dialog as the close message, not in a second one. Taking it on.
