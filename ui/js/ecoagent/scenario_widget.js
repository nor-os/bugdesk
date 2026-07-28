/**
 * scenario_widget.js — topbar dropdown for selecting / managing scenarios.
 *
 * A scenario is a named parameter-override preset that re-shapes the
 * world at construction time (`build_world_config` folds the active
 * scenario's overrides into the archetype params). The implicit
 * "Baseline" scenario carries no overrides — it's the project's
 * status quo.
 *
 * UI: a small `<button>` parked in the workspace top bar next to the
 * sim controls. The current scenario's label is displayed; clicking
 * opens a menu listing Baseline + every saved scenario + "Manage
 * scenarios…" which opens the scenario editor in a workspace tab.
 * Choosing a scenario calls `scenario_set_active` which resets the
 * world so the next Run picks up the overrides.
 *
 * Pairs with the backend bridge methods:
 *   scenarios_list / scenario_save / scenario_delete / scenario_set_active
 */

import { openForm, openConfirm } from './ui/modal.js';
import { ActionDropdown } from '../ui/components/action_dropdown.js';
import { toastSuccess } from './ui/toast.js';

export function installScenarioWidget({ eventBus, logger, workspaceTabs } = {}) {
    const log = logger ?? { warn(){}, error(){}, debug(){} };
    const w = new ScenarioWidget(eventBus, log, workspaceTabs);
    w.install();
    return w;
}


class ScenarioWidget {
    constructor(eventBus, log, workspaceTabs) {
        this.eventBus = eventBus;
        this.log = log;
        this.workspaceTabs = workspaceTabs ?? null;
        this._scenarios = [];
        this._activeId = null;
        this._widget = null;
        this._menu = null;
    }

    async install() {
        // Mount the trigger button right next to the sim controls.
        // Tiling shell relocates sim controls into `.global-top-bar
        // .bar-right` and deletes `.workspace-top-bar` outright, so we
        // look for `.sim-controls` first (in whatever parent it ended
        // up in) and fall back to the legacy `.workspace-top-bar`.
        const simCtl = document.querySelector('.sim-controls');
        const topbar = simCtl?.parentElement
                    ?? document.querySelector('.workspace-top-bar');
        if (!topbar) {
            // Chrome isn't built yet — retry next frame.
            requestAnimationFrame(() => this.install());
            return;
        }
        if (document.getElementById('ea-scenario-widget')) return;

        this._widget = document.createElement('div');
        this._widget.id = 'ea-scenario-widget';
        this._widget.className = 'ea-scenario-widget';
        this._widget.innerHTML = `
            <button type="button" class="ea-scenario-widget__button"
                    data-role="picker" title="Switch scenario">
                <span class="material-symbols-outlined">science</span>
                <span class="ea-scenario-widget__label">Baseline</span>
                <span class="material-symbols-outlined ea-scenario-widget__caret">expand_more</span>
            </button>
        `;
        // The batch-mode toggle that used to sit here moved next to the
        // Run button (runtime_controls.js owns it) so it's visually
        // fused with the action it modifies. The scenario widget just
        // selects WHICH scenario; the run controls own the WHAT-Run-does.
        // Park the widget right after the sim-controls block so it
        // lines up visually with Run/Pause/Step/Reset. Falls back to
        // appending into the topbar if sim-controls couldn't be found.
        if (simCtl) simCtl.parentElement.insertBefore(this._widget, simCtl.nextSibling);
        else topbar.appendChild(this._widget);

        this._widget.querySelector('[data-role="picker"]')
            .addEventListener('click', () => this._openMenu());

        // Refresh after a project switch since scenarios are per-project.
        this.eventBus?.on?.('ecoagent:project:changed', () => this._refresh());
        // Stay in sync with the sidebar's scenario panel — when the user
        // adds/renames/deletes/activates a scenario there, refresh our
        // own label.
        this.eventBus?.on?.('ecoagent:scenarios:changed', () => this._refresh());
        // Surface batch completions — the toggle UI lives in
        // runtime_controls, but the scenario picker is still the most
        // natural place to nudge the user that the cached results
        // (which feed scenario switching) have been refreshed.
        this.eventBus?.on?.('ecoagent:batch:completed', (p) => {
            const n = p?.total ?? p?.completed ?? 0;
            toastSuccess('Batch complete',
                `Finished ${n} scenario${n === 1 ? '' : 's'}.`);
            this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        });

        await this._refresh();
    }

    async _refresh() {
        try {
            const res = await window.pywebview?.api?.scenarios_list?.();
            this._scenarios = Array.isArray(res?.scenarios) ? res.scenarios : [];
            this._activeId  = res?.active || null;
        } catch (err) {
            this.log.warn?.('scenarios_list failed', { err });
        }
        this._renderLabel();
    }

    _renderLabel() {
        const labelEl = this._widget?.querySelector('.ea-scenario-widget__label');
        if (!labelEl) return;
        if (!this._activeId) {
            labelEl.textContent = 'Baseline';
            return;
        }
        const s = this._scenarios.find((x) => x.id === this._activeId);
        labelEl.textContent = (s?.label || s?.id || 'Baseline');
    }

    async _openMenu() {
        this._closeMenu();
        const menu = document.createElement('div');
        menu.className = 'ea-scenario-menu';

        const items = [
            { id: null, label: 'Baseline', description: 'No overrides — status quo' },
            ...this._scenarios,
        ];

        menu.innerHTML = `
            <div class="ea-scenario-menu__header">Scenario</div>
            ${items.map((s) => {
                const active = (s.id || null) === this._activeId;
                return `
                    <button class="ea-scenario-menu__item ${active ? 'ea-scenario-menu__item--active' : ''}"
                            data-id="${esc(s.id || '')}">
                        <span class="material-symbols-outlined ea-scenario-menu__check">
                            ${active ? 'check' : ''}
                        </span>
                        <span class="ea-scenario-menu__body">
                            <span class="ea-scenario-menu__name">${esc(s.label || s.id || 'Baseline')}</span>
                        </span>
                    </button>
                `;
            }).join('')}
            <div class="ea-scenario-menu__sep"></div>
            <button class="ea-scenario-menu__item" data-action="new">
                <span class="material-symbols-outlined">add</span>
                <span class="ea-scenario-menu__name">New scenario…</span>
            </button>
            <button class="ea-scenario-menu__item" data-action="manage"
                    ${this._scenarios.length === 0 ? 'disabled' : ''}>
                <span class="material-symbols-outlined">tune</span>
                <span class="ea-scenario-menu__name">Manage scenario…</span>
            </button>
        `;

        document.body.appendChild(menu);
        this._menu = menu;
        // Use Ecosim's shared auto-positioner (ActionDropdown.position):
        // it prefers below the trigger, flips to above if needed, aligns
        // the menu's left edge with the trigger when there's room on the
        // right, and flips to right-edge alignment otherwise — which is
        // what makes the menu pop out to the left when the widget sits
        // near the right edge of the viewport. Position-aware out of
        // the box, same as every other dropdown in the app.
        ActionDropdown.position(this._widget, menu);

        const dismiss = (e) => {
            if (e && menu.contains(e.target)) return;
            this._closeMenu();
        };
        const onKey = (e) => { if (e.key === 'Escape') this._closeMenu(); };
        setTimeout(() => {
            document.addEventListener('click', dismiss, true);
            document.addEventListener('keydown', onKey);
        }, 0);
        this._menuCleanup = () => {
            document.removeEventListener('click', dismiss, true);
            document.removeEventListener('keydown', onKey);
        };

        menu.querySelectorAll('[data-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._closeMenu();
                const id = btn.dataset.id || null;
                this._setActive(id);
            });
        });
        menu.querySelector('[data-action="new"]')
            ?.addEventListener('click', () => { this._closeMenu(); this._onNew(); });
        menu.querySelector('[data-action="manage"]')
            ?.addEventListener('click', () => { this._closeMenu(); this._onManage(); });
    }

    _closeMenu() {
        if (this._menuCleanup) { this._menuCleanup(); this._menuCleanup = null; }
        this._menu?.remove();
        this._menu = null;
    }

    async _setActive(id) {
        try {
            const res = await window.pywebview?.api?.scenario_set_active?.(id);
            if (res?.ok === false) { this.log.warn?.(res.error); return; }
        } catch (err) {
            this.log.warn?.('scenario_set_active failed', { err });
            return;
        }
        this._activeId = id;
        this._renderLabel();
        // The world was reset by the backend so the next Run picks up
        // the overrides — surface that to other panels.
        this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        this.eventBus?.emit?.('ecoagent:run:completed', { kind: 'reset' });
    }

    async _onNew() {
        const data = await openForm({
            title: 'New scenario',
            fields: [
                { name: 'id',    label: 'Id',          type: 'text', required: true,
                  placeholder: 'e.g. stimulus' },
                { name: 'label', label: 'Label',       type: 'text', required: true,
                  placeholder: 'e.g. Fiscal stimulus' },
                { name: 'description', label: 'Description (optional)', type: 'text' },
            ],
            submitLabel: 'Create',
        });
        if (!data) return;
        const id = String(data.id).trim().toLowerCase().replace(/\s+/g, '-');
        if (!id) return;
        try {
            const res = await window.pywebview?.api?.scenario_save?.(
                id, data.label, data.description, {},
            );
            if (res?.ok === false) { this.log.warn?.(res.error); return; }
        } catch (err) {
            this.log.warn?.('scenario_save failed', { err });
            return;
        }
        await this._refresh();
        this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        this._openEditor(id);
    }

    _onManage() {
        if (this._scenarios.length === 0) return;
        // Open the editor on the active scenario if one is selected,
        // otherwise the first saved one.
        const sid = this._activeId || this._scenarios[0]?.id;
        if (sid) this._openEditor(sid);
    }

    _openEditor(scenarioId) {
        const s = this._scenarios.find((x) => x.id === scenarioId);
        this.workspaceTabs?.openTab({
            kind: 'scenario', entityId: scenarioId,
            label: s?.label || scenarioId, icon: 'science',
        });
    }

}

// ─── Shared batch-mode flag ─────────────────────────────────────────────
// Two consumers: this widget owns the toggle UI, and runtime_controls
// reads the flag in _onRun. localStorage is the source of truth so the
// preference survives reloads.
const BATCH_MODE_KEY = 'ecoagent.batchMode';

export function isBatchModeOn() {
    try { return localStorage.getItem(BATCH_MODE_KEY) === '1'; }
    catch { return false; }
}

export function setBatchMode(on) {
    try { localStorage.setItem(BATCH_MODE_KEY, on ? '1' : '0'); }
    catch { /* quota */ }
}


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
