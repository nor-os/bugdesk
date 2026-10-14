---
id: 36
type: story
title: "Chart tiles over any bug or backlog attribute, custom fields included"
status: done
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [dashboards, charts, custom-fields]
links: [blocked-by 34]
created: 2026-10-14
updated: 2026-10-14T17:31Z
---

## Description

The data side of the tiles. A tile picks a **source** (bugs or backlog, plus one or more types) and a
**filter**: the same filter the Bugs and Backlog views use, so a saved filter can feed a tile. It then picks
what to plot. Fields come from the project's schema (`schema.js`), so a custom field shows up without code
changes.

- **Group and count** over any field: status (or status category), type, assignee, reporter, severity,
  subsystem, phase, labels and custom select/text fields. Drawn as a bar, pie or donut chart.
- **Numeric aggregates** over numeric fields only (points and custom number fields): sum or average per group,
  histograms, and KPI numbers.
- **Over time** from `created`, `updated` and the History sections: items created and finished per week, as a
  line or area chart.

The tiles themselves are FlexDesk's (FlexDesk STORY-0022, `../FlexDesk/backlog/STORY-0022.md`). This story
turns records into the series those tiles take, and re-renders on `bugs:changed` / `backlog:changed`.

## Acceptance criteria

- [x] A tile's field picker lists every field of the chosen source, custom fields included, and offers numeric aggregates only for numeric fields
- [x] A bar, pie or donut tile shows counts per value of the chosen field, and clicking a bar or slice opens the matching records in the list view
- [x] A KPI tile shows a count, sum or average over the filtered records
- [x] A histogram or sum/average tile works over points and over a custom number field
- [x] A created/finished-per-week tile shows the trend over a chosen date range
- [x] Editing a record (in BugDesk or on disk) updates the tiles that show it without a reload
- [x] Non-numeric points values (`M`, `?`) are left out of numeric aggregates and counted in a note on the tile instead of breaking it
- [x] A tile whose field was since removed from the schema shows an explanatory empty state naming the field, not an error or a blank chart

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman
- 2026-10-14 · norman_agent · status: review -> done

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 5 points, parented to EPIC-0033, blocked by STORY-0034 here and by FlexDesk STORY-0022 (`../FlexDesk/backlog/STORY-0022.md`, still draft) for the tiles themselves. Added an eighth criterion: a tile over a field that has since been removed from the schema degrades to an empty state with an explanation. Eight is the upper limit. If it grows further, split the over-time tile out.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All eight criteria are ticked.

- Tiles cover bugs and backlog: count per any field (custom fields included) as bar, pie or donut; sum, average and histogram over number fields; KPI; created/finished per week.
- A click on a bar opens the matching list. Tiles redraw on record changes; on a real instance an edit on disk changed the bars without a reload.
- `M` and `?` are counted in the tile's note, and a removed field gives an empty state naming it.
- New endpoint: `GET /api/dashboards/status_history`.
- Limits: weeks are counted in UTC, and a saved filter is copied into the tile when chosen.

### 2026-10-14T17:31Z · norman_agent

Accepted by norman; closed with EPIC-0033.
