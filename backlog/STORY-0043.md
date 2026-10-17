---
id: 43
type: story
title: "The Tracker can be switched off in Settings"
status: in-progress
parent: 19
phase:
assignee: norman_agent
reporter: norman
due:
points: 3
subsystem: settings
labels: []
links: []
created: 2026-10-14
updated: 2026-10-17T08:02Z
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

Open questions for refinement, answered by norman on 2026-10-17 (the story is
rescoped: dashboards are always on and cannot be switched off; they have no
top-bar element at all since STORY-0046, so only the Tracker is switched here):

- **Whose setting is it?** Personal: Settings › You › Behaviour, kept in your
  profile, not in `project.json`. It is kept in BugDesk's own state folder
  beside your personal dashboards, so one choice holds in every project.
- **How does it relate to `[tracker] enabled`?** It sits on top of it.
  `enabled = false` in `projects.toml` stays a machine-level hard off
  underneath: the switch then shows off and cannot be turned on, and says why.
- **A dashboard tile that charts tracker records** while the Tracker is off
  shows a short note that the Tracker is switched off, and where to switch it
  back on, instead of a chart. The dashboard and the tile are kept as they
  are. Dashboards listed under the Tracker section are not listed while it is
  off (STORY-0046), and come back with it.
- **Reload, or at once?** A reload, announced before it happens. The top bar,
  the F-keys and the page kinds come from the taxonomy, which is built once at
  module load and baked into the window manager and the saved layouts;
  rebuilding it live would mean tearing down the shell. The switch says it
  reloads, asks before doing so, and reloads by itself.

## Acceptance criteria

- [ ] Settings › You › Behaviour has a **Tracker** switch, on by default, that says it is yours alone; its value is saved to your personal state (one file per profile in BugDesk's state folder, shared by every project), never to `project.json`
- [ ] Changing the switch first asks to confirm, saying BugDesk reloads and nothing is deleted; Cancel leaves it as it was, OK saves it and reloads the page
- [ ] Switched off: the Tracker chip is gone from the top bar and F1, F2 go to Bugs and Backlog with no F-key for the Tracker; the command palette returns no tracker tickets; the left rails and the bottom panel show nothing of the tracker; the help's Getting around and Keyboard topics no longer list it and the Tracker topic is not offered
- [ ] Switched off, a dashboard tile that charts tracker records shows a note that the Tracker is switched off and where to switch it on; a saved tab of a tracker page says the same instead of failing
- [ ] Nothing is deleted: switching back on brings back the chip at its old F-key, the Tracker's dashboards in its rail, its tickets in the palette and its help, with the tracker's records untouched
- [ ] With `[tracker] enabled = false` in `projects.toml` the switch is off and disabled, naming that file; with no tracker set up it is disabled and says so; standalone TicketDesk (`--tracker`) does not offer it
- [ ] The in-app help, README and CHANGELOG describe the switch

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-14T18:09Z · norman_agent

Filed at norman's request ("dashboards shall be a feature disable-able in
settings", "same for tracker"). Left in draft: whether the switch is per person
or per project decides where it lives and who it affects, and that is norman's
call.

### 2026-10-17T08:02Z · norman_agent

Refined with norman's answers of 2026-10-17 (see the description): rescoped to
the Tracker only, a personal switch under Settings › You, `[tracker] enabled`
stays a hard off underneath, tracker tiles show a "switched off" note, and an
announced reload rather than a live change. 7 criteria, 3 points. Taking it on
in the ultra/track-A worktree.
