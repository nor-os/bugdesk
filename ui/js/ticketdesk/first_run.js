/**
 * ticketdesk/first_run.js — "who are you?", asked once.
 *
 * WHY THIS EXISTS. BugDesk's stores are committed to the repo, so two people
 * working the same project share every bug and every backlog item — which is the
 * point. What they must NOT share is identity: every comment is
 * `### date · author`, every queue has an "On me", and a single hardcoded
 * `reviewer` makes all of that meaningless the moment there is a second person.
 * The name is asked for once, written to a git-ignored per-user file beside the
 * store (see server/UserConfig.cs), and never asked for again.
 *
 * WHY IT RUNS BEFORE THE SHELL. `ticketdesk/data.js` resolves HUMAN_AUTHOR and
 * AGENT_AUTHOR ONCE, at module-evaluation time, and `filters.js` bakes those
 * values into filter expressions built at that same moment. Asking for the name
 * after the shell has booted would leave every one of those constants holding
 * the pre-answer default until a reload. So this module is deliberately
 * standalone — no shell imports, its own markup, its own stylesheet — and
 * index.html awaits it before it imports anything else.
 *
 * It is a gate, not a dialog: there is no cancel. The only way past it is a
 * name, because everything downstream is meaningless without one.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Ask for a name and persist the profile.
 *
 * @param {object} cfg  the `/api/config` payload that reported `configured:false`
 * @returns {Promise<object>} the config as it stands afterwards — the caller uses
 *          THIS, not the one it passed in, so the names are the ones just chosen.
 */
export function askForName(cfg) {
    return new Promise((resolve) => {
        const profiles = Array.isArray(cfg?.profiles) ? cfg.profiles : [];

        const root = document.createElement('div');
        root.className = 'bd-firstrun';
        root.innerHTML = `
            <div class="bd-firstrun__card" role="dialog" aria-modal="true"
                 aria-labelledby="bd-firstrun-title">
                <div class="bd-firstrun__brand">
                    <span class="material-symbols-outlined">bug_report</span>
                    <span>BugDesk</span>
                </div>
                <h1 class="bd-firstrun__title" id="bd-firstrun-title">Who's working here?</h1>
                <p class="bd-firstrun__lede">
                    Your name goes on the bugs you file, the comments you write and
                    the items you take.
                </p>

                ${profiles.length ? `
                <div class="bd-firstrun__known">
                    <div class="bd-firstrun__label">Already set up here</div>
                    <div class="bd-firstrun__chips">
                        ${profiles.map((p) => `
                            <button type="button" class="bd-firstrun__chip" data-pick="${esc(p.name)}">
                                ${esc(p.name)}
                            </button>`).join('')}
                    </div>
                </div>` : ''}

                <form class="bd-firstrun__form" novalidate>
                    <label class="bd-firstrun__label" for="bd-firstrun-name">Your name</label>
                    <input class="bd-firstrun__input" id="bd-firstrun-name" name="name"
                           autocomplete="name" spellcheck="false" maxlength="60"
                           placeholder="e.g. alice" />

                    <details class="bd-firstrun__more">
                        <summary>Name the agent too</summary>
                        <label class="bd-firstrun__label" for="bd-firstrun-agent">
                            Agent name
                        </label>
                        <input class="bd-firstrun__input" id="bd-firstrun-agent" name="agentName"
                               spellcheck="false" maxlength="60"
                               placeholder="derived from your name" />
                        <p class="bd-firstrun__hint">
                            The name your AI assistant signs its comments with.
                            Left blank it becomes <code>&lt;your name&gt;_agent</code>.
                        </p>
                    </details>

                    <div class="bd-firstrun__error" role="alert" hidden></div>

                    <button type="submit" class="bd-firstrun__go">
                        Start using BugDesk
                    </button>
                </form>

                <p class="bd-firstrun__foot">
                    Saved to <code>${esc(cfg?.configDir || '.bugdesk')}</code>.
                    You can change it later.
                </p>
            </div>`;

        document.body.appendChild(root);

        const form = root.querySelector('form');
        const nameEl = root.querySelector('#bd-firstrun-name');
        const agentEl = root.querySelector('#bd-firstrun-agent');
        const errEl = root.querySelector('.bd-firstrun__error');
        const goEl = root.querySelector('.bd-firstrun__go');

        const fail = (msg) => {
            errEl.textContent = msg;
            errEl.hidden = false;
            goEl.disabled = false;
            goEl.textContent = 'Start using BugDesk';
        };

        const submit = async (name, agentName) => {
            const clean = String(name || '').trim();
            if (!clean) { fail('Enter a name to continue.'); nameEl.focus(); return; }

            errEl.hidden = true;
            goEl.disabled = true;
            goEl.textContent = 'Saving…';
            try {
                const res = await fetch('/api/config/user', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({ name: clean, agentName: String(agentName || '').trim() }),
                });
                const j = await res.json().catch(() => null);
                if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
                root.remove();
                resolve(j);
            } catch (err) {
                // A failure here is not cosmetic — nothing downstream works
                // without a name — so it is reported in the gate rather than
                // logged to a console nobody has open.
                fail(`Could not save your name: ${err?.message || err}`);
            }
        };

        // An existing profile is one click: the common case on a second checkout
        // is "me again", not a new person.
        root.querySelectorAll('[data-pick]').forEach((btn) => {
            btn.addEventListener('click', () => submit(btn.dataset.pick, ''));
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            submit(nameEl.value, agentEl.value);
        });

        requestAnimationFrame(() => nameEl.focus());
    });
}

/**
 * The whole boot-time identity step: fetch the config, gate on it if needed.
 * Returns the config the rest of the app should use. A bridge that cannot be
 * reached falls back to the generic defaults WITHOUT gating — an unreachable
 * server is not something the user can fix by typing their name, and a browser
 * stuck behind an unanswerable prompt is worse than one showing empty states.
 */
export async function resolveIdentity() {
    const fallback = { humanAuthor: 'reviewer', agentAuthor: 'agent', configured: false };
    let cfg;
    try {
        const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
        cfg = res.ok ? await res.json() : null;
        if (!cfg?.ok) throw new Error('bridge returned no config');
    } catch (err) {
        console.warn('BugDesk: /api/config unavailable, using defaults', err);
        return fallback;
    }

    if (cfg.configured) return cfg;
    return askForName(cfg);
}

/**
 * Adopt the identity the bridge just confirmed, everywhere it is visible NOW.
 *
 * A name change used to write the profile and stop there, which is why it read
 * as doing nothing: `HUMAN_AUTHOR` is resolved once at module load, so no page
 * picks it up, and the one always-visible indicator — the chip in the
 * bottom-left corner that the README calls "the piece of state you most need to
 * be able to check at a glance" — was rendered at boot from a snapshot nobody
 * ever refreshed. You changed your name, and the corner still said the old one.
 *
 * So this does the three things that make a change observable without a reload:
 *
 *   1. re-points `window.__BUGDESK_CONFIG__`, which is what every module reads
 *      at load and what the next page to mount will therefore see;
 *   2. mirrors the pair into the settings store, so Settings › General ›
 *      Authorship shows the truth rather than whatever was typed there once;
 *   3. announces it, so the chip repaints.
 *
 * What it CANNOT do is retro-fit the constants already baked into filter
 * expressions built at module-evaluation time. That is what the reload offer is
 * for, and why it is offered rather than assumed.
 *
 * @param {object} cfg  a `/api/config`-shaped payload
 * @returns {{humanChanged: boolean, agentChanged: boolean}}
 */
export async function applyIdentity(cfg, { eventBus } = {}) {
    const before = (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__) || {};
    const humanChanged = (cfg.humanAuthor || '') !== (before.humanAuthor || '');
    const agentChanged = (cfg.agentAuthor || '') !== (before.agentAuthor || '');

    if (typeof window !== 'undefined') {
        window.__BUGDESK_CONFIG__ = {
            ...before,
            humanAuthor: cfg.humanAuthor || before.humanAuthor,
            agentAuthor: cfg.agentAuthor || before.agentAuthor,
            collaborators: Array.isArray(cfg.collaborators) ? cfg.collaborators : before.collaborators,
            assignees: Array.isArray(cfg.assignees) ? cfg.assignees : before.assignees,
        };
    }

    // Keep the Settings rows honest. They are an EDITOR for the profile, not a
    // second copy of it, so they must never be left holding a name the profile
    // has moved on from — that stale value is the whole bug this fixes.
    try {
        const { setSetting, getSetting } = await import('../core/settings.js');
        if (getSetting('bugdesk.humanName') !== (cfg.humanAuthor || '')) {
            setSetting('bugdesk.humanName', cfg.humanAuthor || '');
        }
        if (getSetting('bugdesk.agentName') !== (cfg.agentAuthor || '')) {
            setSetting('bugdesk.agentName', cfg.agentAuthor || '');
        }
    } catch (err) {
        console.warn('BugDesk: could not mirror the identity into settings', err);
    }

    eventBus?.emit?.('bugdesk:identity-changed', {
        humanAuthor: cfg.humanAuthor, agentAuthor: cfg.agentAuthor, user: cfg.user,
    });
    return { humanChanged, agentChanged };
}

/**
 * Keep Settings › General › Authorship and the per-user profile in agreement.
 *
 * Without this the two drift in the worst possible way: the setting is
 * browser-local, so the UI would post comments as the new name while
 * `GET /api/config` — which is what the /bugs and /backlog skills read — still
 * reported the old one. Two surfaces disagreeing about who you are is exactly
 * what the profile exists to prevent.
 *
 * A name change is treated as "switch to that person's profile, creating it if
 * it is new", not "rename me". That is the honest reading in a multi-user repo:
 * the field selects an identity, and identities own their own filters. The
 * setting's description says so.
 *
 * Called once, after the shell is up (install.js). The values only take effect
 * on reload — HUMAN_AUTHOR/AGENT_AUTHOR are resolved at module-evaluation time
 * — which both schema entries already flag with `reloadHint`.
 */
export function installAuthorshipWriteThrough({ eventBus, getSetting } = {}) {
    if (!eventBus?.on || !getSetting) return null;

    const push = async () => {
        const name = String(getSetting('bugdesk.humanName') || '').trim();
        // A blank name means "use the server default" — there is no profile to
        // select, and posting an empty name would just be rejected.
        if (!name) return;
        const agent = String(getSetting('bugdesk.agentName') || '').trim();
        // Already what the bridge told us? Then this change came FROM the
        // bridge — applyIdentity mirrors every confirmed identity back into
        // these two rows — and posting it again would be a pointless round trip
        // that toasts "signed in as…" at somebody who did not just sign in.
        const live = (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__) || {};
        if (name === (live.humanAuthor || '') && agent === (live.agentAuthor || '')) return;
        try {
            const res = await fetch('/api/config/user', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ name, agentName: agent }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            await applyIdentity(j, { eventBus });
            eventBus.emit?.('toast:show', {
                type: 'info',
                message: `Signed in as ${j.humanAuthor}. Reload BugDesk for saved filters and`
                       + ' the "On me" views to follow.',
            });
        } catch (err) {
            eventBus.emit?.('toast:show', {
                type: 'error',
                message: `Could not save your name to the profile: ${err?.message || err}`,
            });
        }
    };

    const subs = [
        eventBus.on('settings:bugdesk.humanName:changed', push),
        eventBus.on('settings:bugdesk.agentName:changed', push),
    ];
    return { dispose: () => subs.forEach((s) => s?.dispose?.()) };
}

/**
 * "Change your name" — the same question the first-run gate asks, asked again.
 *
 * The hamburger entry and the bottom-bar chip used to route to
 * Settings › General › Authorship. That is a page, opened in the PRIMARY tile,
 * so from a focused side tile it looked like the click did nothing at all —
 * and an item labelled with an ellipsis promises a dialog anyway.
 *
 * Writes straight through to the profile, like the gate does, so the UI and
 * `GET /api/config` cannot disagree about who you are. Entering a different
 * name SWITCHES profile (creating it if new) rather than renaming you in
 * place — identities own their own filters.
 */
/** The conventional agent name for a person — the same rule the server applies
 *  in ProjectConfig.AgentNameFor, so the two never disagree. */
export const agentNameFor = (human) => {
    const slug = String(human || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug ? `${slug}_agent` : '';
};

export async function openIdentityDialog({ eventBus } = {}) {
    const cfg = window.__BUGDESK_CONFIG__ || {};
    let lastName = cfg.humanAuthor || '';

    let profiles = [];
    try {
        const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
        const j = res.ok ? await res.json() : null;
        if (j?.ok) {
            profiles = Array.isArray(j.profiles) ? j.profiles : [];
            lastName = j.humanAuthor || lastName;
        }
    } catch (err) {
        console.warn('BugDesk: could not list profiles', err);
    }

    // There is no "your name is locked by the environment" case any more.
    // BUGDESK_HUMAN seeds a profile when there is none; the profile this dialog
    // writes is what wins from then on. See server/UserConfig.cs.
    const known = profiles.map((p) => p.name).filter(Boolean);
    // In tracker mode nobody in the store has an assistant, so there is no agent
    // to name — asking would be asking for a value nothing ever reads.
    const agents = (window.__BUGDESK_CONFIG__ || {}).agentsAssignable !== false;
    const { openForm } = await import('../ecoagent/ui/modal.js');
    const result = await openForm({
        title: 'Who is working here?',
        submitLabel: 'Use this name',
        fields: [
            { name: 'name', label: 'Your name', type: 'select', create: true,
              required: true, options: known,
              placeholder: 'type a name, or pick one you have used here',
              hint: known.length > 1
                  ? 'A different name switches to that profile, with its own saved filters.'
                  : '' },
            ...(agents ? [{ name: 'agentName', label: 'Agent name', type: 'text',
              placeholder: 'derived from your name',
              hint: 'The name your AI assistant signs its comments with.' }] : []),
            { name: 'manage', label: 'Everyone else', type: 'select',
              options: [{ value: '', label: 'Leave the collaborator list alone' },
                        { value: 'yes', label: 'Open the collaborator list…' }],
              hint: 'Who else can be assigned work on this repo.' },
        ],
        defaults: {
            name: cfg.humanAuthor || '',
            agentName: cfg.agentAuthor === 'agent' ? '' : (cfg.agentAuthor || ''),
            manage: '',
        },
        // Follow the name: an agent called `<you>_agent` needs no explaining and
        // no decision, and two people's agents can never end up signing
        // identically. Only auto-filled while it still matches what the name
        // implies, so a deliberately chosen agent name is never overwritten.
        onFieldChange: (field, value, api) => {
            if (field !== 'name' || !agents) return;
            const current = String(api.get('agentName') || '').trim();
            if (current && current !== agentNameFor(lastName)) return;
            lastName = String(api.get('name') || '');
            api.set('agentName', agentNameFor(lastName));
        },
    });
    if (!result) return null;

    if (result.manage === 'yes') {
        const { openCollaborators } = await import('./collaborators.js');
        return openCollaborators({ eventBus });
    }

    const name = String(result.name || '').trim();
    if (!name) return null;

    try {
        const res = await fetch('/api/config/user', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name, agentName: String(result.agentName || '').trim() }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);

        // Make it true in THIS page before saying anything about it: the config
        // snapshot every module reads, the Settings rows, and the chip in the
        // corner. Without this the dialog wrote a file and nothing on screen
        // moved, which is indistinguishable from a broken button.
        const { humanChanged, agentChanged } = await applyIdentity(j, { eventBus });

        if (!humanChanged && !agentChanged) {
            eventBus?.emit?.('toast:show', { type: 'info', message: `Still ${j.humanAuthor}.` });
            return j;
        }

        // What a reload still buys: HUMAN_AUTHOR/AGENT_AUTHOR are baked into the
        // filter expressions built at module-evaluation time, so "On me" and
        // "Needs my reply" go on meaning the old person until the page reloads.
        // Compare the NAMES, not the profile slug — the slug is unchanged when
        // you fix the capitalisation of your own name or rename just the agent,
        // and those used to silently skip the offer.
        eventBus?.emit?.('toast:show', {
            type: 'info',
            message: `Now ${j.humanAuthor}. Reload for the saved filters and "On me" to follow.`,
        });
        if (window.confirm(
            `Signed in as ${j.humanAuthor}. Reload now so every view uses the new name?`)) {
            window.location.reload();
        }
        return j;
    } catch (err) {
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save your name: ${err?.message || err}` });
        return null;
    }
}
