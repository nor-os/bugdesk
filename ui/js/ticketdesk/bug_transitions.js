/**
 * bug_transitions.js — where a bug can move, and the message a move takes.
 *
 * ONE LIST for every door: the Action buttons on a bug's page and the queue's
 * right-click menu offer exactly these moves, so the two cannot disagree about
 * what a bug in `testing` may become.
 *
 * Every move except "Start investigation" needs a MESSAGE: why it is closed,
 * why it is reopened, what to test, what still fails, why it goes back to open.
 * The message is a comment, written in the same save as the status change and
 * tagged with it (`status: testing -> closed` in the comment header), so the
 * thread reads as a history of decisions. If you commented on the bug within
 * the last five minutes, that comment IS the message: no dialog, and the
 * bridge tags it instead.
 *
 * FOR THE FUTURE: on a platform with a workflow engine, the engine should own
 * this policy (which moves need a message, the window, the tagging), and this
 * module and the bridge should only carry it out. See the note in the bridge's
 * POST /api/bugs/{id}.
 */

import { HUMAN_AUTHOR, fetchBug, humanizeStatus, patchBug } from './data.js';
import { customStatus, customStatuses, isFinished } from './schema.js';
import { movesFor, planMove } from './workflow.js';

/** Moves per status, primary (the usual next step) first: `[label, target]`. */
//
// CLOSE IS ALWAYS OFFERED. A bug that turns out to be a non-issue, a duplicate
// nobody linked or a wontfix should not have to be walked through testing to be
// put down; the close message (required, like every move but starting work)
// says why it ended where it did.
export const BUG_TRANSITIONS = {
    open: [['Start investigation', 'investigation'], ['Close', 'closed']],
    investigation: [['Hand to testing', 'testing'], ['Close', 'closed'], ['Back to open', 'open']],
    testing: [['Back to investigation', 'investigation'], ['Close', 'closed'], ['Back to open', 'open']],
    // Reopening goes to OPEN: a closed bug that is wrong again starts over as
    // something nobody has looked at yet.
    closed: [['Reopen', 'open']],
};

/** How long before a move a comment of yours still counts as its message. */
/**
 * The moves of one bug, built-in and custom (Settings › Record types).
 *
 * A custom status is not a rung on the chevron ladder: it is somewhere a bug can
 * be PUT — `blocked`, `wontfix` — so every unfinished bug is offered a move into
 * each one, after its built-in moves. A bug IN a custom status is offered the
 * way back (to the status it was configured to sit after, else investigation),
 * Close, and the other custom statuses; one in a finished custom status, the
 * way back and Reopen.
 *
 * @param {string} status  the bug's raw status
 * @param {string} [type]  the bug's raw type (`bug`, `regression`, `task`)
 * @returns {Array<[label, target]>}
 */
export function bugMoves(status, type = 'bug') {
    const custom = customStatuses('bugs', type);
    const into = (except) => custom
        .filter((s) => s.name !== except)
        .map((s) => [`Move to ${s.label || s.name}`, s.name]);
    if (BUG_TRANSITIONS[status]) {
        return status === 'closed' ? BUG_TRANSITIONS.closed : [...BUG_TRANSITIONS[status], ...into(status)];
    }
    const me = customStatus('bugs', type, status);
    const back = me?.after && BUG_TRANSITIONS[me.after] && me.after !== 'closed' ? me.after : 'investigation';
    if (me && isFinished('bugs', type, status)) {
        return [[`Back to ${humanizeStatus(back)}`, back], ['Reopen', 'open']];
    }
    // In a custom status, or one the schema no longer knows: the way back first.
    return [[`Back to ${humanizeStatus(back)}`, back], ['Close', 'closed'], ...into(status)];
}

export const MESSAGE_WINDOW_MS = 5 * 60 * 1000;

/** Whether moving `from` → `to` needs a message. Only starting work does not. */
export function needsMessage(from, to) {
    return !(from === 'open' && to === 'investigation');
}

/** What the message box asks for, per move. */
export function messagePrompt(from, to) {
    if (to === 'closed') return 'Close message: what fixed it, or why it is closed';
    if (from === 'closed') return 'Reopen message: what is wrong again';
    if (to === 'testing') return 'What changed, and what to test';
    if (to === 'investigation') return 'What still fails';
    if (to === 'open') return 'Why it goes back to open';
    return 'Message';
}

/**
 * The comment that already is this move's message: the thread's last comment,
 * written by `author`, within the window, and not already some move's message.
 * A date-only header (from before comments carried a time) never counts.
 *
 * @param {{date:string, author:string, note?:string}[]} comments  oldest first
 * @returns {object|null}
 */
export function recentMessage(comments, author, now = Date.now()) {
    const last = Array.isArray(comments) ? comments[comments.length - 1] : null;
    if (!last || last.note) return null;
    if (String(last.author || '').trim().toLowerCase() !== String(author || '').trim().toLowerCase()) return null;
    if (!/T\d{2}:\d{2}/.test(String(last.date || ''))) return null;
    const at = Date.parse(last.date);
    if (Number.isNaN(at)) return null;
    const age = now - at;
    return age >= -60 * 1000 && age <= MESSAGE_WINDOW_MS ? last : null;
}

/**
 * Find out how a move gets its message. Resolves to `null` when the user
 * cancelled, else to the extra fields the status patch carries: `{ comment }`
 * from the dialog, `{ tagRecentComment: true }` when a recent comment is the
 * message, or `{}` when the move needs none.
 *
 * @param {{bugId:number, from:string, to:string, label:string, title?:string,
 *          author?:string, ask?:Function}} o  `ask` stands in for the dialog in tests
 */
export async function resolveMoveMessage({ bugId, from, to, label, title = '', author = HUMAN_AUTHOR, ask = null,
                                          required = null, prompt: question = '', comments = null }) {
    // `required` is the configured move's rule (Settings › Workflow); without one,
    // the built-in rule: every move but starting work.
    if (!(required ?? needsMessage(from, to))) return {};
    try {
        const thread = comments ?? (await fetchBug(bugId))?.comments;
        if (recentMessage(thread, author)) return { tagRecentComment: true };
    } catch { /* no fresh copy: ask, rather than guess */ }
    const prompt = question || messagePrompt(from, to);
    const open = ask || (async (opts) => {
        const { openForm } = await import('../ui/components/modal.js');
        return openForm(opts);
    });
    const result = await open({
        title: `${label} — #${bugId}${title ? ` ${title}` : ''}`,
        fields: [{ name: 'message', label: prompt, type: 'textarea', rows: 6, required: true }],
        submitLabel: label,
    });
    const message = String(result?.message || '').trim();
    return message ? { comment: message } : null;
}

/**
 * Move a bug from wherever it is, with its message: the right-click menu's
 * path. Returns the saved bug, or null when the user cancelled.
 */
export async function moveBug({ bugId, from, to, label, title = '', author = HUMAN_AUTHOR, ask = null }) {
    const bug = await fetchBug(bugId).catch(() => null);
    const type = bug?.type || 'bug';
    const move = bugMovesFor(from, type).find((m) => m.to === to && m.label === label)
        || bugMovesFor(from, type).find((m) => m.to === to)
        || { to, label, message: needsMessage(from, to), flow: null };
    const patch = await planBugMove({ bugId, bug: bug || { id: bugId, status: from, comments: [] }, move, from, title, author, ask });
    if (!patch) return null;
    return patchBug(bugId, patch, author);
}

/**
 * The moves a bug is offered: the project's table (Settings › Workflow) when it
 * has one, else the built-in moves, custom statuses included. One list for the
 * Action buttons and the right-click menu.
 */
export const bugMovesFor = (status, type = 'bug') => movesFor('bugs', type, status, bugMoves(status, type));

/**
 * What a move saves: its status, its message and what its flow collected — one
 * patch, or null when anything was cancelled (workflow.js's planMove).
 */
export async function planBugMove({ bugId, bug, move, from, title = '', author = HUMAN_AUTHOR, ask = null }) {
    const open = ask || (async (opts) => {
        const { openForm } = await import('../ui/components/modal.js');
        return openForm(opts);
    });
    return planMove({
        store: 'bugs', record: bug, move, ask: open,
        askMessage: (prompt) => resolveMoveMessage({
            bugId, from, to: move.to || from, label: move.label, title, author, ask: open,
            required: true, prompt, comments: bug?.comments || null,
        }),
    });
}
