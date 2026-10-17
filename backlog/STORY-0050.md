---
id: 50
type: story
title: "Duplicate, won't fix and the other built-in actions are configurable flows"
status: review
parent: 17
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: workflow
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T14:50Z
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

- [x] A flow can add a link: the flow editor offers an "Add a link" step with a verb (one of the seven link verbs) and a target, and "Ask for input" can ask for "A record", which opens the record picker and gives later steps the picked record's reference and title.
- [x] The link is saved in the same write as the rest of the move or action, added to the record's existing links (never replacing them). The step can leave a comment on the linked record; that comment is written after the record itself.
- [x] A link step whose target is not a record, is the record itself, or names a record that does not exist is refused by the server, and nothing is written to either record.
- [x] Settings › Workflow lists "Mark as duplicate and close" among each bug type's actions and "Mark as duplicate and drop" among each backlog type's actions. Each runs a flow built from those steps: pick the master, add `duplicates <master>`, set the resolution to duplicate, comment, then close or drop. A project can rename, change or remove it there, and the record pages and right-click menus then offer the changed version (or nothing).
- [x] With nothing configured, Mark as duplicate does what it did before: one save links the record, closes the bug or drops the item, comments on it, and leaves the courtesy comment on the master. Cancelling the picker writes nothing.
- [x] `POST /api/bugs/{id}/duplicate-of` and `POST /api/backlog/{id}/duplicate-of` still work as before, and now also set the resolution to duplicate.
- [x] Bugs and backlog items have a `resolution` field (fixed, won't fix, cannot reproduce, not a bug, works as designed, duplicate), stored as one frontmatter line. Closing a bug, dropping an item, or moving either into a custom finished status asks for the resolution in the same dialog as the message (default: fixed for a bug, won't fix for a drop). Moving a backlog item to done does not ask. Reopening or restoring clears the resolution. If the move's flow sets or clears the resolution itself, nobody is asked.
- [x] The resolution is shown and can be changed on the bug page and the item page, is a field in the bug and backlog filter editors, and flows can set it, clear it and test it with If … otherwise.
- [x] The in-app help, README and CHANGELOG describe the link step, the default duplicate action and resolutions.

Out of scope (norman, 2026-10-17): unblock as an action, block for backlog types, reassign/hand-to as an action, split, and reopen-with-a-reason for backlog items. Convert and Delete stay hard-coded.

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee:  -> norman_agent
- 2026-10-17 · norman_agent · status: in-progress -> review
- 2026-10-17 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request ("did we really cover them all? ... What about mark as duplicate and done?"). Duplicate-and-close/drop does exist, but it is hard-coded, and a flow cannot express it because no node adds a link. The gaps are listed above. In draft until norman picks the scope.

### 2026-10-17T06:22Z · norman_agent

Refined with norman's answers (2026-10-17). Scope is the three proposed items: (1) an `add-link` flow step, with the target picked by a prompt; (2) Duplicate rebuilt as a default, editable action made from that step (bugs: duplicate and close; backlog: duplicate and drop), keeping the courtesy comment on the master and the existing API endpoints; (3) a `resolution` field set by close-type moves (fixed, won't fix, cannot reproduce, not a bug, works as designed, duplicate), shown and filterable like other fields. Unblock, block for backlog, reassign, split and reopen-with-a-reason are out of scope. 9 criteria, 5 points. My decisions within that scope: moving a backlog item to done does not ask for a resolution, because done already says how it ended; the resolution is asked in the same dialog as the close message, not in a second one. Taking it on.

### 2026-10-17T07:20Z · norman_agent

Built on branch ultra/track-C. It stays in progress until the branch is integrated, and then goes back to norman for review. All 9 criteria are ticked: each was checked on a scratch BugDesk (port 8783, a copy of this repo's bugs/ and backlog/) in Edge over CDP, with real clicks and keys.

- **Add a link** is a new flow step: a verb (one of the seven) and a target, plus an optional comment for the linked record. **Ask for input** can now answer with **A record**, which opens the record picker; later steps can insert the picked record's reference and `… — its title`. A save carries `addLinks`. The server resolves each target first, merges the links (it never replaces them), and writes the comments on the targets after the record itself. An unknown verb, a record that does not exist, a non-reference or the record itself is refused with a 400, and nothing is written (checked with curl). Settings › Workflow refuses such a step, and a resolution that is not one of the six words, on save.
- **Duplicate** is now every type's default action, "Mark as duplicate and close" (bugs) and "Mark as duplicate and drop" (backlog). It runs a flow: pick the master, add `duplicates`, comment on the master, set resolution: duplicate, comment, close or drop. In the UI, BUG-0013 was closed as a duplicate of BUG-0014 and STORY-0041 dropped as a duplicate of EPIC-0021: one save each, History line and both comments included. Settings › Workflow lists it. Renaming it to "Duplicate of another bug" saved only `types.bugs.bug`, and the bug page then offered it as a move under the new name. A renamed copy ran from a row's right-click menu. Removing it took it off the page. Both `duplicate-of` routes still work, and now also write `resolution: duplicate`.
- **Resolution**: closing BUG-0012 asked for the resolution in the close dialog (Fixed first). Picking Won't fix with the keyboard wrote `resolution: wont-fix`, and Reopen removed the line. Drop on a story asks in a small dialog of its own (Won't fix first), Restore removes it, and Done asks nothing. The field is on both record pages. In the bug filter editor, "Resolution is duplicate" matched exactly the two duplicates.
- Help (bug lifecycle), README (duplicate, Add a link, Resolutions, API row), CHANGELOG, and the bugs/backlog skills' field notes and Duplicate steps are updated.

Suites: server build OK; check-graph OK; eslint 0 errors; test-ui 221/221; test-tracker 34/34; test-dom 206/206 (8 new tests for this story; the old duplicate test now expects one save to `/api/bugs/42`). Three dashboard suites already fail at the base commit a7bb723 (test-dashboards 1, test-dashboards-example 1, test-dashboards-dom 12). They fail the same way with this change and do not touch this code.

### 2026-10-17T14:50Z · norman_agent

Handing back for review. On main and pushed: c375b2c (refined and taken on), 5e0dea1 (flows can add links, Duplicate is an editable action, records have a resolution), 315505f (review fixes: older workflows keep Mark as duplicate; Resolution can be hidden and keeps hand-typed values).

Built: an "Add a link" flow step (verb, target, optional comment on the linked record), and "Ask for input" can answer with "A record" through the record picker; the server refuses a bad target and writes nothing. "Mark as duplicate and close" (bugs) and "Mark as duplicate and drop" (backlog) are every type's default action, built from those steps and editable in Settings › Workflow. A type list saved before this story gets the default added; removing it is saved as `workflow.removedDefaults.<store>.<type>`. With nothing configured it works as before, and the duplicate-of routes still work and set the resolution. A `resolution` field: closing, dropping or moving to a finished status asks for it, reopening clears it; it is on both record pages and in both filter editors, flows can set, clear and test it, it can be hidden per type, and a hand-typed value is kept.

Verified on scratch projects (one with no workflow, one with a pre-story type list) in headless Edge over CDP with real input: the link step, the duplicate action from the page and the row menu, removing it, resolution on close, drop and reopen. Checked again on main at 4b75945 before this handback: server builds (0 errors), check-graph OK, eslint 0 errors, test-ui 225/225, test-tracker 35/35, test-dom 218/218, test-dashboards 59/59, test-dashboards-dom 58/58, test-dashboards-example 8/8, test-dashboards-tracker 14/14, test-tracker-off 17/17, sync-flexdesk --check matches flexdesk@0.16.1.

Open, for you to judge:
- With no workflow configured, the right-click row menu does not offer Mark as duplicate (the page does); once a type has its own list, it does. Not a regression.
- A removed default Duplicate cannot be brought back from the UI after saving (help says a removed one stays removed); there is no "restore default".
- The first Settings save of a pre-story type list writes the action into project.json for that type.
- The default flow sets resolution: duplicate even on a type that hides Resolution.
- A recent comment of yours (under 5 minutes), such as the note an Add-a-link save leaves, stands in for the close message, and the resolution is then asked on its own.
- A mass action `action:duplicate` on a type whose list gets the default only at load time is refused by the server.
- The default action is recognised by its id `duplicate`; an unrelated action with that id counts as it.
- The Duplicate picker's title is now the flow's question. The Resolution field in the backlog filter editor is covered by a DOM test, not checked in a browser.
- In schema.js the customFields doc comment now sits above the RESOLUTIONS block, not above customFields.
- Older, not from this story: saving the bug page writes `title:` without quotes.
- The record was refined, claimed and commented on ultra/track-C and reached main at integration.
