/**
 * homes.js — a section's home as a built-in dashboard (STORY-0047).
 *
 * The Tracker chip opens the Tracker home: an ordinary dashboard (the same
 * page, grid, tiles and tile settings as every other one, page.js), whose
 * DEFAULT is defined here in code rather than kept in anybody's file. So a
 * project with nothing configured gets it, and a new BugDesk can improve it.
 *
 * EDITING IT SAVES AN OVERRIDE. The first change (a tile moved, added, removed
 * or configured) writes the whole dashboard as an entry of `dashboards` in
 * project.json under the home's id (`home-tracker`) and `"home": "tracker"`,
 * and from then on that entry IS the home. "Reset to default" deletes it, and
 * the built-in is back. The override is never listed in a rail (library.js
 * leaves it out): it is the home, not a dashboard of its own.
 *
 * WHICH project.json. The tracker belongs to no project, so its home's
 * override is in the TRACKER's own project.json, through its own API: the
 * page's in standalone TicketDesk, `/t/api` on a project page (the tracker's
 * copy of instance.js). Every project shows the same Tracker home.
 *
 * BUGS AND BACKLOG (STORY-0048) have a home the same way: a builtin here, an
 * override (`home-bugs`, `home-backlog`) in the project's own project.json. It
 * is what their chips open; the queue and the board are one rail click away.
 *
 * NO NAMES IN A BUILT-IN. An override is shared, so a tile that means "me"
 * names a built-in view (`on-us`, `needs-reply`), which every person's page
 * resolves to themselves, never a literal name that would show the person who
 * edited the home their own bugs.
 */

import { CONFIG, apiUrl, trackerModule } from '../ticketdesk/instance.js';
import { DUE_SOON_DAYS } from '../ticketdesk/backlog_data.js';
import { DASHBOARD_VERSION, homeIdOf, homeOf, readEntry } from './model.js';
import { deleteShared, loadShared, saveShared } from './store.js';

const clause = (field, op, value) => ({ kind: 'clause', field, op, value });

/** What the old hand-built page called its fourth section: nobody on it, or no date. */
const GAPS = { kind: 'group', op: 'OR', children: [clause('assignee', 'is', 'none'), clause('dueState', 'is', 'none')] };

/** Refined work that can be picked up: an epic is refined too, but nobody starts an epic. */
const READY = { kind: 'group', op: 'AND', children: [clause('status', 'is', 'refined'), clause('type', 'none_of', ['epic'])] };

/** The sections that have a built-in home. */
export const HOME_SECTIONS = Object.freeze(['bugs', 'backlog', 'tracker']);

const listTile = (source, sort) => (id, at, title, empty, binding) => ({
    id, type: 'flexdesk.list', h: 3, ...at, config: { title, empty_text: empty, binding: { source, sort, ...binding } },
});
const chartTile = (id, at, title, chartType, binding) => ({
    id, type: 'flexdesk.chart', h: 4, ...at, config: { title, chart_type: chartType, binding },
});

/**
 * The Bugs home: how bad, how fast it moves, and what is waiting on you —
 * your own and your agent's bugs, the agent's comments you have not answered,
 * and what is in testing. Lists newest update first (bugs have no target date).
 */
function bugsHome() {
    const list = listTile('bugs', 'updated');
    return {
        id: homeIdOf('bugs'), name: 'Bugs', version: DASHBOARD_VERSION, home: 'bugs', section: 'bugs',
        tiles: [
            chartTile('severity', { x: 0, y: 0, w: 5 }, 'Open bugs by severity', 'bar',
                { source: 'bugs', filter: { key: 'active' }, plot: 'count', field: 'severity' }),
            chartTile('per-week', { x: 5, y: 0, w: 7 }, 'Opened and closed per week', 'line',
                { source: 'bugs', plot: 'perWeek' }),
            list('on-us', { x: 0, y: 4, w: 6 }, 'On me or my agent', 'Nothing open is on you or your agent.', { filter: { key: 'on-us' } }),
            list('reply', { x: 6, y: 4, w: 6 }, 'Needs my reply', 'Nothing is waiting for your reply.', { filter: { key: 'needs-reply' } }),
            list('testing', { x: 0, y: 7, w: 12 }, 'In testing', 'Nothing is in testing.', { filter: { key: 'testing' } }),
        ],
    };
}

/**
 * The Backlog home: the work in flight (in progress, in review), what can be
 * picked up next (refined stories), what nobody can start yet (drafts to
 * refine), and how far each epic has got.
 */
function backlogHome() {
    const list = listTile('backlog', 'updated');
    return {
        id: homeIdOf('backlog'), name: 'Backlog', version: DASHBOARD_VERSION, home: 'backlog', section: 'backlog',
        tiles: [
            list('active', { x: 0, y: 0, w: 6 }, 'In progress', 'Nothing is in progress.', { filter: { key: 'active' } }),
            list('review', { x: 6, y: 0, w: 6 }, 'In review', 'Nothing is waiting for a review.', { filter: { key: 'review' } }),
            list('ready', { x: 0, y: 3, w: 6 }, 'Ready to start', 'Nothing refined is waiting to be picked up.',
                { sort: 'due', filter: { expr: READY, label: 'Refined, ready to start' } }),
            list('drafts', { x: 6, y: 3, w: 6 }, 'Waiting for refinement', 'No epic or story is waiting to be refined.',
                { sort: 'created', filter: { key: 'unrefined' } }),
            chartTile('per-epic', { x: 0, y: 6, w: 12, h: 5 }, 'Progress per epic', 'bar-stacked',
                { source: 'backlog', types: ['story', 'task'], plot: 'count', field: 'epic', split: 'statusCategory' }),
        ],
    };
}

/**
 * The built-in home of `section`, as a raw entry, or null. The Tracker's is
 * what the old Tracker page showed, as tiles: what is late, worst first; what
 * falls due this week; who has what; and what the tracker cannot answer.
 */
export function builtinHome(section) {
    if (section === 'bugs') return bugsHome();
    if (section === 'backlog') return backlogHome();
    if (section !== 'tracker') return null;
    const list = listTile('tracker', 'due');
    return {
        id: homeIdOf('tracker'), name: 'Tracker', version: DASHBOARD_VERSION, home: 'tracker', section: 'tracker',
        tiles: [
            list('overdue', { x: 0, y: 0, w: 12 }, 'Overdue', 'Nothing is late.', { filter: { key: 'overdue' } }),
            list('soon', { x: 0, y: 3, w: 6 }, `Due in the next ${DUE_SOON_DAYS} days`, 'Nothing falls due this week.', { filter: { key: 'duesoon' } }),
            { id: 'people', type: 'flexdesk.people', x: 6, y: 3, w: 6, h: 3,
                config: { title: 'Who has what', empty_text: 'Nothing is open.', binding: { source: 'tracker' } } },
            list('gaps', { x: 0, y: 6, w: 12 }, 'Needs a name or a date', 'Everything open has somebody on it and a date to hit.',
                { filter: { expr: GAPS, label: 'Needs a name or a date' } }),
        ],
    };
}

/** The API of the store whose project.json keeps `section`'s override. */
async function apiFor(section) {
    if (section === 'tracker' && CONFIG.mode !== 'tracker') return (await trackerModule('instance.js')).apiUrl;
    return apiUrl;
}

/**
 * The home as it stands: `{entry, overridden, broken}`. `entry` is the
 * override when there is one (read like any entry, so an unreadable one shows
 * as unreadable, with Reset), else the built-in. `broken` is why the
 * dashboards of that project.json cannot be read at all: the built-in is
 * shown then, and nothing is saved over the file.
 */
export async function loadHome(section) {
    const builtin = readEntry(builtinHome(section));
    let found;
    try {
        found = await loadShared(await apiFor(section));
    } catch (err) {
        return { entry: builtin, overridden: false, broken: `the dashboards could not be loaded (${err.message})` };
    }
    if (found.broken) return { entry: builtin, overridden: false, broken: found.broken };
    const override = found.entries.find((e) => e.id === homeIdOf(section) && homeOf(e) === section);
    return override ? { entry: override, overridden: true, broken: null } : { entry: builtin, overridden: false, broken: null };
}

/** Save `raw` as `section`'s override, marked as the home. */
export async function saveHome(section, raw) {
    await saveShared({ ...raw, id: homeIdOf(section), home: section }, await apiFor(section));
}

/** Reset to default: delete the override. */
export async function resetHome(section) {
    await deleteShared(homeIdOf(section), await apiFor(section));
}

/** Where the override is kept, as the page says it. */
export const homeFile = (section) => (section === 'tracker' && CONFIG.mode !== 'tracker'
    ? "the tracker's project.json" : 'project.json');
