/**
 * agent_dashboard.js — per-agent dashboard window.
 *
 * Opened by clicking a row in the bottom panel's Population tab. Pulls
 * together, for one agent instance, everything the bottom panel shows
 * globally:
 *
 *   Identity     — agent id, archetype, account / param counts.
 *   Parameters   — construction / live parameter values.
 *   Accounts     — ledger accounts with inline balance-history sparklines.
 *   Brain        — the inspector tree, with per-key sparklines.
 *   Activity     — bus messages this agent published + run-log entries
 *                  that name it.
 *
 * Rendered into a ManagedWindow so several agents can be compared side
 * by side; reopening the same agent reuses its window with fresh data.
 */

import { renderSparkline } from './charts.js';
import { renderInspectorTree } from './inspector.js';


/**
 * Open (or refocus) the dashboard window for one agent instance.
 *
 *   archetype — archetype key the sample belongs to.
 *   sample    — one entry from world_live_population / world_preview_population:
 *               {agent_id, params, accounts, brain}.
 *   editorEl  — optional DOM element with the EDITABLE parameter surface
 *               (agent instances flow). When supplied it replaces the
 *               read-only Parameters value table, so the window is a single
 *               unified dashboard + parameter-editing view rather than two
 *               separate surfaces.
 *
 * Returns the ManagedWindow instance so callers can keep it in sync
 * (e.g. re-open with fresh data after a mutation, or close on dispose).
 */
export async function openAgentDashboard({ archetype, sample, editorEl = null }) {
    if (!sample || !sample.agent_id) return null;
    const { ManagedWindow } = await import('../../ui/components/managed_window.js');
    const agentId = sample.agent_id;
    const winId = `ea-agent-dashboard:${agentId}`;

    const body = buildSkeleton({ archetype, sample, editorEl });

    let win;
    const existing = ManagedWindow.get?.(winId);
    if (existing && existing.contentContainer) {
        existing.contentContainer.innerHTML = '';
        existing.contentContainer.appendChild(body);
        existing.show();
        win = existing;
    } else {
        win = new ManagedWindow({
            id: winId,
            title: `Agent · ${agentId}`,
            icon: 'contacts',
            content: body,
            minWidth: 420, minHeight: 320,
            defaultWidth: 760, defaultHeight: 580,
            modal: false,
        });
        win.show();
    }

    // Sections that need round-trips fill in after the window is up.
    populateBrain(body, agentId, sample.brain);
    populateAccounts(body, sample.accounts || []);
    populateActivity(body, agentId);
    return win;
}


function buildSkeleton({ archetype, sample, editorEl = null }) {
    const root = document.createElement('div');
    root.className = 'ea-dash';

    const params = sample.params || {};
    const accounts = sample.accounts || [];
    const paramCount = Object.keys(params).length;

    root.appendChild(section('Identity', identityHtml(archetype, sample, paramCount, accounts.length)));
    // Parameters section: an editable override editor when the caller
    // supplies one (unified dashboard + edit), else the read-only value table.
    if (editorEl instanceof HTMLElement) {
        const paramSec = section('Parameters', '');
        paramSec.querySelector('.ea-dash__section-body').appendChild(editorEl);
        root.appendChild(paramSec);
    } else {
        root.appendChild(section('Parameters', paramsHtml(params)));
    }

    const accSec = section('Accounts', '<div class="ea-dash__loading">Loading balances…</div>');
    accSec.dataset.role = 'accounts';
    root.appendChild(accSec);

    const brainSec = section('Brain', '<div class="ea-dash__loading">Loading brain…</div>');
    brainSec.dataset.role = 'brain';
    root.appendChild(brainSec);

    const actSec = section('Activity', '<div class="ea-dash__loading">Loading activity…</div>');
    actSec.dataset.role = 'activity';
    root.appendChild(actSec);

    return root;
}


function section(title, innerHtml) {
    const el = document.createElement('section');
    el.className = 'ea-dash__section';
    el.innerHTML = `
        <h3 class="ea-dash__section-title">${esc(title)}</h3>
        <div class="ea-dash__section-body">${innerHtml}</div>
    `;
    return el;
}

function sectionBody(root, role) {
    return root.querySelector(`[data-role="${role}"] .ea-dash__section-body`);
}


// ----------------------------------------------------------- Identity

function identityHtml(archetype, sample, paramCount, accCount) {
    const chips = [
        ['badge', sample.agent_id],
        ['category', archetype || '—'],
        ['tune', `${paramCount} param${paramCount === 1 ? '' : 's'}`],
        ['account_balance', `${accCount} account${accCount === 1 ? '' : 's'}`],
    ];
    return `<div class="ea-dash__chips">${
        chips.map(([icon, text]) => `
            <span class="ea-dash__chip">
                <span class="material-symbols-outlined">${icon}</span>
                ${esc(text)}
            </span>`).join('')
    }</div>`;
}


// --------------------------------------------------------- Parameters

function paramsHtml(params) {
    const names = Object.keys(params);
    if (names.length === 0) {
        return '<div class="ea-dash__empty">No parameters.</div>';
    }
    return `
        <table class="ea-table ea-dash__table">
            <thead><tr><th>Name</th><th>Value</th></tr></thead>
            <tbody>
                ${names.map((n) => `
                    <tr>
                        <td><code>${esc(n)}</code></td>
                        <td>${esc(fmtValue(params[n]))}</td>
                    </tr>`).join('')}
            </tbody>
        </table>
    `;
}


// ----------------------------------------------------------- Accounts

async function populateAccounts(root, accounts) {
    const target = sectionBody(root, 'accounts');
    if (!target) return;
    if (accounts.length === 0) {
        target.innerHTML = '<div class="ea-dash__empty">No accounts.</div>';
        return;
    }
    // Pull balance history for each account that carries a stable id
    // (live runs only — previews have no history).
    const histories = {};
    await Promise.all(accounts.map(async (a) => {
        if (!a.id) return;
        try {
            const series = await window.pywebview?.api?.world_account_history?.(a.id) ?? [];
            if (Array.isArray(series) && series.length > 1) histories[a.id] = series;
        } catch { /* no sparkline for this account */ }
    }));

    target.innerHTML = `
        <table class="ea-table ea-dash__table">
            <thead><tr>
                <th>Account</th><th>Type</th><th>Balance</th><th>History</th>
            </tr></thead>
            <tbody>
                ${accounts.map((a) => {
                    const series = a.id ? histories[a.id] : null;
                    const spark = series
                        ? renderSparkline(series, { width: 96, height: 16 })
                        : '<span class="ea-dash__muted">—</span>';
                    return `
                        <tr>
                            <td>${esc(a.label || a.id || '?')}</td>
                            <td><span class="ea-dash__muted">${esc(a.type || a.asset_kind || '')}</span></td>
                            <td class="ea-dash__num">${esc(fmtNum(a.initial_value))}</td>
                            <td>${spark}</td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>
    `;
}


// -------------------------------------------------------------- Brain

async function populateBrain(root, agentId, brainNode) {
    const target = sectionBody(root, 'brain');
    if (!target) return;
    const histories = {};
    try {
        const keys = await window.pywebview?.api?.world_brain_history_keys?.(agentId) ?? [];
        await Promise.all(keys.map(async (k) => {
            const series = await window.pywebview?.api?.world_brain_history?.(agentId, k) ?? [];
            if (Array.isArray(series) && series.length > 1) histories[k] = series;
        }));
    } catch { /* fall back to no sparklines */ }

    if (!brainNode || (brainNode.kind === 'dict' && !(brainNode.length > 0))) {
        target.innerHTML = '<div class="ea-dash__empty">Empty brain.</div>';
        return;
    }
    target.innerHTML = '';
    const tree = document.createElement('div');
    tree.className = 'ea-inspector__tree';
    target.appendChild(tree);
    renderInspectorTree(tree, brainNode, histories);
}


// ----------------------------------------------------------- Activity

async function populateActivity(root, agentId) {
    const target = sectionBody(root, 'activity');
    if (!target) return;

    let events = [];
    let runlog = [];
    try {
        const ev = await window.pywebview?.api?.world_event_log?.(0);
        events = (Array.isArray(ev?.entries) ? ev.entries : [])
            .filter((e) => e.source === agentId);
    } catch { /* ignore */ }
    try {
        const rl = await window.pywebview?.api?.world_run_log?.(0);
        runlog = (Array.isArray(rl?.entries) ? rl.entries : [])
            .filter((e) => String(e.source || '').includes(agentId));
    } catch { /* ignore */ }

    const busHtml = events.length === 0
        ? '<div class="ea-dash__empty">No bus messages published by this agent.</div>'
        : `<table class="ea-table ea-dash__table">
                <thead><tr><th>Tick</th><th>Topic</th><th>Payload</th></tr></thead>
                <tbody>${events.slice(-50).reverse().map((e) => `
                    <tr>
                        <td class="ea-dash__num">t${esc(e.tick)}</td>
                        <td><code>${esc(e.topic || '')}</code></td>
                        <td><code>${esc(payloadSummary(e.payload))}</code></td>
                    </tr>`).join('')}</tbody>
           </table>`;

    const runHtml = runlog.length === 0
        ? '<div class="ea-dash__empty">No run-log entries name this agent.</div>'
        : `<table class="ea-table ea-dash__table">
                <thead><tr><th>Tick</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
                <tbody>${runlog.slice(-50).reverse().map((e) => `
                    <tr class="ea-dash__run--${esc(e.level || 'info')}">
                        <td class="ea-dash__num">t${esc(e.tick)}</td>
                        <td>${esc(e.level || '')}</td>
                        <td><code>${esc(e.source || '')}</code></td>
                        <td>${esc(e.message || '')}</td>
                    </tr>`).join('')}</tbody>
           </table>`;

    target.innerHTML = `
        <h4 class="ea-dash__subhead">Bus messages published</h4>
        ${busHtml}
        <h4 class="ea-dash__subhead">Run-log entries</h4>
        ${runHtml}
    `;
}


// ------------------------------------------------------------- helpers

function payloadSummary(node) {
    if (!node) return '—';
    if (node.kind === 'primitive') {
        if (node.value == null) return 'null';
        if (typeof node.value === 'string') return JSON.stringify(node.value);
        return String(node.value);
    }
    if (node.kind === 'list')   return `[${node.length} items]`;
    if (node.kind === 'dict')   return `{${node.length} keys}`;
    if (node.kind === 'object') return `<${node.type}>`;
    if (node.kind === 'repr')   return node.repr || '';
    if (node.kind === 'elided') return '…';
    return '';
}

function fmtValue(v) {
    if (v == null) return '—';
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (typeof v === 'object') return `{${Object.keys(v).length} keys}`;
    if (typeof v === 'number') return fmtNum(v);
    return String(v);
}

function fmtNum(v) {
    if (v == null) return '—';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '—';
        return Number(v.toFixed(4)).toString();
    }
    return String(v);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
