---
id: 2
type: story
title: "Store-specific prefixes"
status: review
parent: 19
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-13T04:24Z
---

## Description

Make it so that ticket numbers can have (in settings) configurable prefixes. Also make it configurable, if the numbers are padded and by how much and also by how much we by default increment and also min (start) number.

## Acceptance criteria

- [x] In settings, each store can set the prefix per record type (BUG; PROJ, EPIC, STORY, TASK), the zero-padding width (0 = none), the start number and the increment
- [x] New records are named and numbered by these settings; with none set, numbering is exactly as today (`BUG-0042`, padding 4, +1)
- [x] Existing records keep their file names, open normally, and links and typed references to them still resolve after the settings change
- [x] Typed references (e.g. `BUG-0042` auto-linking) and link targets recognise both the configured prefixes and the previous ones
- [x] An id is still never reused: the next id is above every id ever seen (BUG-0015's rule) and not below the start number
- [x] A prefix that clashes with another type's, or contains characters invalid in a file name, is refused with a message
- [x] The /bugs and /backlog skills describe how to read the configured prefixes from `.bugdesk/project.json`

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-13 · norman_agent · status: refined -> in-progress
- 2026-10-13 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 7 criteria, 5 points, under EPIC-0019. Criterion 5 keeps the
never-reuse rule from BUG-0015. Criterion 7 is there because agents write record
files by hand, so the skills have to know about custom prefixes too.

### 2026-10-13T04:24Z · norman_agent (status: in-progress -> review)

Built in e9cac40. All seven criteria are met.

- **Settings › General › Project › Edit numbering…** Per store: the prefix
  (one for bugs; one each for project, epic, story, task), zero-padding (0 =
  none), first number and increment. Saved as `numbering` in
  `.bugdesk/project.json`.
- **New records** are named and numbered by it. With nothing set, it's exactly
  today's `BUG-0042`, padded to 4, +1. Tested: bugs `DEF`, pad 3, start 100,
  step 2 gave `DEF-100.md` then `DEF-102.md`; stories `US` unpadded gave
  `US-26.md`.
- **Existing records keep their file names.** A record is found by its id
  under any prefix and padding the store has used. The cache and the watcher
  read every `*-*.md`, and the watcher now tells the stores apart by folder,
  not by prefix.
- **References:** typed references, link targets, `#REF` autolinks and search
  accept the current prefixes, every replaced one (kept under `previous` by
  the save) and the defaults. New references are written with the current
  prefix. Checked: after BUG→DEF, `BUG-0011` still resolves in a link and in
  search; the bug shows as `DEF-011`.
- **Ids are never reused:** the next id is above every id ever seen under ANY
  prefix (folder, git history, trash), plus the step, never below the start.
- **Refused, with a message:** a prefix that is not letters (`B2`), one two
  types share, or one another store or type still reads (bugs `STORY` while
  old `STORY-7` references exist).
- **Skills:** /bugs has "Numbering: prefixes, padding, start and step", and
  /backlog points to it.

While testing I found that my change had briefly broken the tracker: it has no
bug folder, and the watcher choked on the empty path. Fixed before this
commit; the full smoke test and TicketDesk config load cleanly. DOM 160/160,
UI 218/218, tracker 34/34.
