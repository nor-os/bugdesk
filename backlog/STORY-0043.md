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
updated: 2026-10-17T09:18Z
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

- [x] Settings › You › Behaviour has a **Tracker** switch, on by default, that says it is yours alone; its value is saved to your personal state (one file per profile in BugDesk's state folder, shared by every project), never to `project.json`
- [x] Changing the switch first asks to confirm, saying BugDesk reloads and nothing is deleted; Cancel leaves it as it was, OK saves it and reloads the page
- [x] Switched off: the Tracker chip is gone from the top bar and F1, F2 go to Bugs and Backlog with no F-key for the Tracker; the command palette returns no tracker tickets; the left rails and the bottom panel show nothing of the tracker; the help's Getting started and Keyboard topics no longer list it and the Tracker topic is not offered
- [x] Switched off, a dashboard tile that charts tracker records shows a note that the Tracker is switched off and where to switch it on; a saved tab of a tracker page says the same instead of failing
- [x] Nothing is deleted: switching back on brings back the chip at its old F-key, the Tracker's dashboards in its rail, its tickets in the palette and its help, with the tracker's records untouched
- [x] With `[tracker] enabled = false` in `projects.toml` the switch is off and disabled, naming that file; with no tracker set up it is disabled and says so; standalone TicketDesk (`--tracker`) does not offer it
- [x] The in-app help, README and CHANGELOG describe the switch

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

### 2026-10-17T08:34Z · norman_agent

Built on branch ultra/track-A (b0bac7b), not merged yet; stays in-progress
until integration. All 7 criteria ticked after a check on a scratch instance.

- Settings › You › Behaviour has a new **Pages** group with the **Tracker**
  switch (`ticketdesk/tracker_setting.js`). Its value is `tracker` in
  `preferences.json` in BugDesk's state folder, per profile, beside the
  personal dashboards (`GET/POST /api/personal/preferences`); on is the
  default, so switching on clears the key. `/api/config` folds it into
  `tracker.available` and reports `switchedOff` and `machineOff`.
- The switch asks first ("BugDesk reloads … Nothing is deleted … Only you
  are affected"), then saves and reloads by itself.
- Off: the taxonomy has no Tracker chip, so F1/F2 are Bugs/Backlog and F3
  does nothing; the palette does not ask the tracker; the help drops the
  Tracker topic and leaves it out of Getting started, Dashboards and
  Keyboard (F1 … F2). The tracker kinds stay defined without a chip, so
  saved tracker tabs stay in the layout and come back when it is switched
  on; one that shows while off says why.
- A dashboard tile over tracker records says "The Tracker is switched off
  for you. Switch it back on under Settings › You › Behaviour › Tracker."
  With `enabled = false` it names projects.toml instead.

Checked on a scratch server (8781) in headless Edge over CDP, with real
clicks and keys: Cancel on the confirm (nothing saved); OK switched it off
and the page reloaded by itself, then chips Bugs, Backlog, F3 stayed on
Backlog, Ctrl+K "vendor" found nothing (three tracker tickets before),
the help had no Tracker topic, and the Mixed dashboard's tracker KPI showed
the note while its bugs KPI showed 8. Switching on brought back the chip
at F3, "My tracker" in the Tracker rail, the palette hits, the help topic
and the KPI (2). The tracker's records were untouched. A tracker tab put in
the saved layout (by editing desktops.json while off) showed the banner.
`enabled = false` showed the switch off and disabled with the projects.toml
note; no `[tracker]` showed "No tracker is set up"; `--tracker` showed the
row with no switch, and ignored a saved `tracker: false`. A second project
on the same server saw the same choice. Not covered: a floating tracker
window does not survive a reload with the Tracker on or off, because the
WM does not save floating windows; that is not new with this story.
Tests: test-tracker-off 13 (new), test-dom 198, test-ui 222,
test-tracker 35, test-dashboards 52, test-dashboards-dom 46,
test-dashboards-tracker 7, test-dashboards-example 8; eslint 0 errors;
check-graph OK.

### 2026-10-17T09:18Z · norman_agent

Fixed what review found:

- A tracker tile's settings, opened while the Tracker is off, used to offer
  only Bugs and Backlog, so Save turned a shared tracker tile into a bugs one
  for everybody. The dialog now shows "Tracker (not here now)" with the
  switched-off note, and Save keeps the tile's source and filter untouched;
  only how it looks can change.
- Behaviour's Reset now switches the Tracker back on, asking first and
  reloading like the switch does. It does nothing when the switch is already
  on, is off for the machine, or there is no tracker.
- Help: with `enabled = false`, Getting started names projects.toml instead
  of pointing at a switch that cannot be pressed. Keyboard lists the pages
  that are actually there, so a bugs-only or backlog-only project reads
  "(Backlog) F1".
- POST /api/personal/preferences answers 400, not 500, for a body that is
  not JSON, and turns down keys it does not know.
- Criterion 3 said "Getting around"; the topic is called Getting started,
  so I changed the wording. The meaning is the same.

Checked on the scratch server (8781) in headless Edge over CDP (9321), with
the Tracker switched off. I opened a project dashboard's tracker KPI
settings and saw the one-option Records select and the note. I renamed the
tile by typing and pressed Save. project.json kept source tracker and
filter overdue under the new title, and after switching back on the tile
showed Overdue 2. Reset on Behaviour opened "Switch the Tracker on", and
OK cleared preferences.json and reloaded with the Tracker chip back. With
`enabled = false`, Getting started named projects.toml, and the
backlog-only project's Keyboard read "(Backlog) F1". curl: `{bad`,
`{"foo":1}`, `{"tracker":"no"}` and a string body all gave 400.

Tests: test-tracker-off 17 (four new), test-ui 222, test-tracker 35,
test-dashboards 52, test-dom 198, test-dashboards-dom 46 (the
"no tracker" case now expects the tile's own source kept),
test-dashboards-tracker 7, test-dashboards-example 8; eslint
0 errors; check-graph OK; server build 0 warnings.
