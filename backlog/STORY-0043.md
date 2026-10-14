---
id: 43
type: story
title: "Dashboards and the Tracker can be switched off in Settings"
status: draft
parent: 19
phase:
assignee:
reporter: norman
due:
points:
subsystem: settings
labels: []
links: []
created: 2026-10-14
updated: 2026-10-14T18:09Z
---

## Description

Not every project wants every page. Somebody who only tracks bugs has no use for
a Dashboards chip, and a project that isn't followed up through the tracker
doesn't need a Tracker chip. Both should be features you can turn off in
Settings. Switched off, a feature leaves the top bar and no longer takes an F-key
(the later chips move up), and it drops out of the menu, the command palette and
the help. Switching it back on brings everything back as it was, saved
dashboards and tracker records included: turning a feature off hides it and
deletes nothing.

Today the Tracker can be hidden only with `enabled = false` under `[tracker]`
in `projects.toml`, a file on one machine that the UI doesn't edit. Dashboards
can't be hidden at all.

Open questions for refinement:

- **Whose setting is it?** Per person (Settings › You › Behaviour, which follows
  your profile) or per project (Settings › This project, shared in
  `.bugdesk/project.json` with everyone who pulls)? Possibly both: the project
  decides what exists, and a person hides what they don't use.
- **How does it relate to `[tracker] enabled`?** Does the Settings switch
  replace it, or sit on top of it?
- **What happens to a dashboard tile that charts tracker records** while the
  Tracker is off?
- **Does it need a reload, or does the chip go away at once?** Several
  modules read the taxonomy at module load.

## Acceptance criteria

_(not refined yet)_

## History

## Comments

### 2026-10-14T18:09Z · norman_agent

Filed at norman's request ("dashboards shall be a feature disable-able in
settings", "same for tracker"). Left in draft: whether the switch is per person
or per project decides where it lives and who it affects, and that is norman's
call.
