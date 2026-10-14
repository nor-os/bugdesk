/**
 * ticketdesk/builtin_moves.js — the built-in moves of a store, as a table.
 *
 * A store or type with no move table (Settings › Workflow) moves the built-in
 * way: the bug page's transitions (./bug_transitions.js) and the backlog's
 * ladder (./backlog_data.js's stageActions), custom statuses included. This
 * writes those down as the rows a table holds — `{from, label, to, message,
 * prompt?}` — for "Customise the moves" and for giving every transition a flow
 * (STORY-0028), so a table started from them offers exactly what the records
 * offered before. `prompt` is what the message box asked.
 */

import { bugMoves, messagePrompt, needsMessage } from './bug_transitions.js';
import { stageActions } from './backlog_data.js';
import { statusesOf } from './workflow.js';

/**
 * @param {'bugs'|'backlog'} store
 * @param {string[]} types   the table's types — bugs share one table
 * @returns {Array<{from: string, label: string, to: string, message: boolean, prompt?: string}>}
 */
export function builtinTable(store, types) {
    const out = [];
    const seen = new Set();
    for (const type of types) {
        for (const from of statusesOf(store, type)) {
            const list = store === 'bugs' ? bugMoves(from, type) : stageActions({ type, status: from });
            for (const [label, to] of list) {
                const key = `${from}|${label}|${to}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const message = store === 'bugs' && needsMessage(from, to);
                out.push({ from, label, to, message, ...(message ? { prompt: messagePrompt(from, to) } : {}) });
            }
        }
    }
    return out;
}
