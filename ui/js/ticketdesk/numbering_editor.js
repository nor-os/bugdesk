/**
 * ticketdesk/numbering_editor.js — Settings › Numbering: how new records are
 * named. Per store: the prefix (one for bugs, one per backlog type), how far the
 * number is zero-padded (0 = not at all), the first number and the increment.
 *
 * Saved in `.bugdesk/project.json`'s `numbering` (server/Numbering.cs). Nothing
 * is renamed: records keep the names they were written under, and a prefix the
 * save replaces stays readable, so links and typed references to old records
 * still resolve. The bridge refuses a prefix that is not letters, or one two
 * types share, and the form opens again with the message and what was typed.
 */

import { appName } from '../core/app_identity.js';
import { CONFIG, apiUrl } from './instance.js';

const DEFAULT = {
    bugs: { prefix: 'BUG', pad: 4, start: 1, step: 1 },
    backlog: { prefix: { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' }, pad: 4, start: 1, step: 1 },
};

/** Open the dialog. Resolves true once saved. */
export async function openNumberingEditor({ eventBus = null } = {}) {
    const { openForm } = await import('@flexdesk/widgets');
    const cur = CONFIG.numbering || DEFAULT;
    const bugs = { ...DEFAULT.bugs, ...(cur.bugs || {}) };
    const back = { ...DEFAULT.backlog, ...(cur.backlog || {}), prefix: { ...DEFAULT.backlog.prefix, ...(cur.backlog?.prefix || {}) } };
    const hasBugs = CONFIG.store?.hasBugs !== false && CONFIG.mode !== 'tracker';
    let values = {
        bugPrefix: bugs.prefix, bugPad: String(bugs.pad), bugStart: String(bugs.start), bugStep: String(bugs.step),
        projectPrefix: back.prefix.project, epicPrefix: back.prefix.epic, storyPrefix: back.prefix.story, taskPrefix: back.prefix.task,
        itemPad: String(back.pad), itemStart: String(back.start), itemStep: String(back.step),
    };
    let problem = '';
    const num = (name, label, hint) => ({ name, label, type: 'text', required: true, hint });
    for (;;) {
        const answer = await openForm({
            title: 'Numbering',
            fields: [
                ...(problem ? [{ section: `Not saved: ${problem}` }] : []),
                ...(hasBugs ? [
                    { section: 'Bugs' },
                    { name: 'bugPrefix', label: 'Prefix', type: 'text', required: true, hint: 'Letters only — new bugs are named PREFIX-0042.' },
                    num('bugPad', 'Zero-padding', 'Digits the number is padded to; 0 for none.'),
                    num('bugStart', 'First number', 'No new bug is numbered below this.'),
                    num('bugStep', 'Increment', 'How far each new number is above the highest ever used.'),
                ] : []),
                { section: CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog — one number sequence for every type' },
                { name: 'projectPrefix', label: 'Project prefix', type: 'text', required: true },
                { name: 'epicPrefix', label: 'Epic prefix', type: 'text', required: true },
                { name: 'storyPrefix', label: 'Story prefix', type: 'text', required: true },
                { name: 'taskPrefix', label: 'Task prefix', type: 'text', required: true },
                num('itemPad', 'Zero-padding', 'Digits the number is padded to; 0 for none.'),
                num('itemStart', 'First number', 'No new item is numbered below this.'),
                num('itemStep', 'Increment', 'How far each new number is above the highest ever used.'),
            ],
            defaults: values,
            submitLabel: 'Save',
        });
        if (!answer) return false;
        values = { ...values, ...answer };
        const int = (v) => (String(v).trim() === '' ? NaN : Number(v));
        const body = {
            bugs: { prefix: values.bugPrefix, pad: int(values.bugPad), start: int(values.bugStart), step: int(values.bugStep),
                    previous: cur.bugs?.previous || [] },
            backlog: {
                prefix: { project: values.projectPrefix, epic: values.epicPrefix, story: values.storyPrefix, task: values.taskPrefix },
                pad: int(values.itemPad), start: int(values.itemStart), step: int(values.itemStep),
                previous: cur.backlog?.previous || {},
            },
        };
        try {
            const res = await fetch(apiUrl('/project/numbering'), {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ numbering: body }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            CONFIG.numbering = j.numbering;
            eventBus?.emit?.('toast:show', { type: 'info',
                message: `Numbering saved to project.json. Reload ${appName()} for new references to use it.` });
            return true;
        } catch (err) {
            problem = String(err?.message || err).replace(/\n/g, ' · ');
        }
    }
}
