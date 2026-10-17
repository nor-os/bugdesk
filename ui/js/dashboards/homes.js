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
 * STORY-0048 adds Bugs and Backlog homes the same way: a builtin here, an
 * override in the project's own project.json.
 */

import { CONFIG, apiUrl, trackerModule } from '../ticketdesk/instance.js';
import { DUE_SOON_DAYS } from '../ticketdesk/backlog_data.js';
import { DASHBOARD_VERSION, homeIdOf, homeOf, readEntry } from './model.js';
import { deleteShared, loadShared, saveShared } from './store.js';

const clause = (field, op, value) => ({ kind: 'clause', field, op, value });

/** What the old hand-built page called its fourth section: nobody on it, or no date. */
const GAPS = { kind: 'group', op: 'OR', children: [clause('assignee', 'is', 'none'), clause('dueState', 'is', 'none')] };

/** The sections that have a built-in home. */
export const HOME_SECTIONS = Object.freeze(['tracker']);

/**
 * The built-in home of `section`, as a raw entry, or null. What the old
 * Tracker page showed, as tiles: what is late, worst first; what falls due
 * this week; who has what; and what the tracker cannot answer.
 */
export function builtinHome(section) {
    if (section !== 'tracker') return null;
    const list = (id, at, title, empty, binding) => ({
        id, type: 'flexdesk.list', ...at, h: 3, config: { title, empty_text: empty, binding: { source: 'tracker', sort: 'due', ...binding } },
    });
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
