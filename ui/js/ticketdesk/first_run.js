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
                               placeholder="${esc(cfg?.agentAuthor || 'agent')}" />
                        <p class="bd-firstrun__hint">
                            What your AI coding assistant signs its comments as. Must match
                            <code>BUGDESK_AGENT</code>.
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
        try {
            const res = await fetch('/api/config/user', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({
                    name,
                    agentName: String(getSetting('bugdesk.agentName') || '').trim(),
                }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            eventBus.emit?.('toast:show', {
                type: 'info',
                message: `Signed in as ${name}. Reload BugDesk for it to take effect everywhere.`,
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
export async function openIdentityDialog({ eventBus } = {}) {
    const { openForm } = await import('../ecoagent/ui/modal.js');
    const cfg = window.__BUGDESK_CONFIG__ || {};

    let profiles = [];
    let current = null;
    try {
        const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
        const j = res.ok ? await res.json() : null;
        if (j?.ok) { profiles = Array.isArray(j.profiles) ? j.profiles : []; current = j.user; }
    } catch (err) {
        console.warn('BugDesk: could not list profiles', err);
    }

    const known = profiles.map((p) => p.name).filter(Boolean);
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
            { name: 'agentName', label: 'Agent name', type: 'text',
              placeholder: cfg.agentAuthor || 'agent',
              hint: 'What your AI coding assistant signs its comments as. Must match BUGDESK_AGENT.' },
        ],
        defaults: {
            name: cfg.humanAuthor || '',
            agentName: cfg.agentAuthor === 'agent' ? '' : (cfg.agentAuthor || ''),
        },
    });
    if (!result) return null;

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

        // The author names are resolved once, at module-evaluation time, and
        // baked into the filter expressions — so a reload is genuinely required
        // rather than merely tidy. Say so instead of leaving the UI signing
        // comments with the old name.
        const changed = (j.user || '') !== (current || '');
        eventBus?.emit?.('toast:show', {
            type: 'info',
            message: `Now ${j.humanAuthor}. Reload BugDesk for it to take effect everywhere.`,
        });
        if (changed && window.confirm(
            `Signed in as ${j.humanAuthor}. Reload now so every view uses the new name?`)) {
            window.location.reload();
        }
        return j;
    } catch (err) {
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save your name: ${err?.message || err}` });
        return null;
    }
}
