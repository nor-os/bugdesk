---
id: 2
type: story
title: "Store-specific prefixes"
status: refined
parent: 19
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-06T01:56Z
---

## Description

Make it so that ticket numbers can have (in settings) configurable prefixes. Also make it configurable, if the numbers are padded and by how much and also by how much we by default increment and also min (start) number.

## Acceptance criteria

- [ ] In settings, each store can set the prefix per record type (BUG; PROJ, EPIC, STORY, TASK), the zero-padding width (0 = none), the start number and the increment
- [ ] New records are named and numbered by these settings; with none set, numbering is exactly as today (`BUG-0042`, padding 4, +1)
- [ ] Existing records keep their file names, open normally, and links and typed references to them still resolve after the settings change
- [ ] Typed references (e.g. `BUG-0042` auto-linking) and link targets recognise both the configured prefixes and the previous ones
- [ ] An id is still never reused: the next id is above every id ever seen (BUG-0015's rule) and not below the start number
- [ ] A prefix that clashes with another type's, or contains characters invalid in a file name, is refused with a message
- [ ] The /bugs and /backlog skills describe how to read the configured prefixes from `.bugdesk/project.json`

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 7 criteria, 5 points, under EPIC-0019. Criterion 5 keeps the
never-reuse rule from BUG-0015. Criterion 7 is there because agents write record
files by hand, so the skills have to know about custom prefixes too.
