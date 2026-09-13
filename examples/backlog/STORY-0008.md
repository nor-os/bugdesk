---
id: 8
type: story
title: "Export a queue to CSV and JSON"
status: refined
parent: 1
phase:
assignee:
reporter: norman
points: 3
subsystem: export
labels: []
links: [blocks BUG-0006]
created: 2026-09-04
updated: 2026-09-11
---

## Description

A queue is a filter somebody has already thought about; the export is what makes
that thinking useful outside BugDesk. CSV for the spreadsheet the status meeting
actually runs on, JSON for the script that would otherwise re-implement the
filter against the API and get it subtly wrong.

One writer, two encoders. Which rows, which columns and in what order is the
same question whichever file comes out, and answering it twice is how the two
formats end up disagreeing about what a queue contained.

## Acceptance criteria

- [ ] A queue exports from the queue itself, carrying the columns it shows
- [ ] A field holding a comma, a quote or a newline survives the round trip
- [ ] The JSON carries the whole record, not only the columns on screen

## History

- 2026-09-11 · reviewer · status: draft -> refined

## Comments

### 2026-09-11 · reviewer

Refined ahead of the export work rather than alongside it: #6 asks for a JSON
export and is sitting open because nobody had written down what a "queue
export" means. That answer belongs here, so the bug is blocked on this and not
the other way round.
