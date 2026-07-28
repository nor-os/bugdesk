/**
 * bus_topic_inspector.js — per-topic inspector window for the world bus.
 *
 * Opened from the bottom panel's Bus snapshot when the user clicks a
 * topic row. Each topic gets its own ManagedWindow (id keyed by the
 * topic), pre-filtered to that topic but with the filter editable so
 * the user can broaden or refine the view.
 *
 * The window holds the bits that used to live inline in the bottom
 * panel — current payload, full event stream, tick scrubber — plus
 * extra filters (source agent, event kind, tick range) that are awkward
 * to fit in a narrow horizontal strip.
 *
 * Data comes from the shared event_log_store, so the bottom panel and
 * any number of open inspector windows all read from the same buffer.
 * The window subscribes for live updates and also pulls on every
 * `ecoagent:run:tick`, which keeps it fresh even when the bottom panel
 * is collapsed or hidden.
 */

import { DataTable } from '../../ui/components/data_table.js';
import { renderInspectorTree } from './inspector.js';
import { getEvents, maxTick, subscribe as subscribeEvents, fetchEvents }
    from '../event_log_store.js';

const EVENT_KIND_LABEL = {
    'bus.deliver':  'bus · deliver',
    'market.clear': 'market · clear',
};
const KNOWN_KINDS = Object.keys(EVENT_KIND_LABEL);
const EVENT_COL = { TICK: 0, KIND: 1, SOURCE: 2, TOPIC: 3, PAYLOAD: 4, DERIVED: 5 };
const EVENT_HEADERS = ['Tick', 'Kind', 'Source', 'Topic', 'Payload', 'Derived'];


/**
 * Open (or refocus) the bus topic inspector window for `topic`.
 *
 *   topic    — the topic name the user clicked. Used as the default
 *              topic filter and as the window id; clicking the same
 *              topic again brings the existing window forward.
 *   eventBus — app event bus, used to refetch on `ecoagent:run:tick`.
 */
export function openBusTopicInspector({ topic, eventBus = null } = {}) {
    const safeTopic = String(topic || '');
    if (!safeTopic) return null;
    const winId = `ea-bus-inspector:${safeTopic}`;

    // Lazy-imported so the bottom panel doesn't drag the window
    // implementation into its initial bundle.
    return import('../../ui/components/managed_window.js').then(({ ManagedWindow }) => {
        const existing = ManagedWindow.get?.(winId);
        if (existing?.isVisible) { existing.show(); return existing; }

        const inspector = new BusTopicInspector({ topic: safeTopic, eventBus });
        const win = new ManagedWindow({
            id: winId,
            title: `Bus · ${safeTopic}`,
            icon: 'hub',
            content: inspector.root,
            minWidth: 560, minHeight: 420,
            defaultWidth: 880, defaultHeight: 560,
            onClose: () => inspector.dispose(),
        });
        inspector.attachWindow(win);
        win.show();
        return win;
    });
}


class BusTopicInspector {
    constructor({ topic, eventBus }) {
        this._eventBus = eventBus;
        // Filter state — topic pre-filled with the clicked topic but
        // editable. Empty fields mean "no filter".
        this._filter = {
            topic:  String(topic || ''),
            source: '',
            kinds:  new Set(KNOWN_KINDS),  // both kinds on by default
            tickMin: null,
            tickMax: null,
        };
        // Time-travel cursor: null ⇒ live (latest tick). When a number,
        // the event stream and payload snapshot are reconstructed as of
        // that tick.
        this._cursor = null;

        this._table = null;
        this._eventsView = [];
        this._window = null;
        this._buildShell();

        // Live pipeline: store push + tick-driven refetch. The unsub
        // closures are kept so dispose() can tear them down cleanly.
        this._unsubStore = subscribeEvents(() => this._refresh());
        if (this._eventBus?.on) {
            this._onTick = () => fetchEvents();
            this._eventBus.on('ecoagent:run:tick', this._onTick);
            this._eventBus.on('ecoagent:run:completed', this._onTick);
        }
        // First paint from whatever's already in the buffer; kick off a
        // fetch in case nothing has yet.
        this._refresh();
        fetchEvents();
    }

    attachWindow(win) { this._window = win; }

    dispose() {
        try { this._unsubStore?.(); } catch { /* ignore */ }
        if (this._eventBus?.off && this._onTick) {
            this._eventBus.off('ecoagent:run:tick', this._onTick);
            this._eventBus.off('ecoagent:run:completed', this._onTick);
        }
        this._table?.dispose?.();
        this._table = null;
    }

    // --------------------------------------------------------------- DOM

    _buildShell() {
        this.root = document.createElement('div');
        this.root.className = 'ea-bus-inspector';
        this.root.innerHTML = `
            <header class="ea-bus-inspector__filters ea-events-filters">
                <div class="ea-events-filters__row">
                    <span>Topic</span>
                    <input type="search" data-role="f-topic"
                           placeholder="Substring of topic name…" />
                </div>
                <div class="ea-events-filters__row">
                    <span>Source</span>
                    <input type="search" data-role="f-source"
                           placeholder="Substring of source agent / module…" />
                </div>
                <div class="ea-events-filters__row">
                    <span>Kind</span>
                    <div class="ea-bus-inspector__kinds" data-role="f-kinds"></div>
                </div>
                <div class="ea-events-filters__row">
                    <span>Tick range</span>
                    <div class="ea-bus-inspector__range">
                        <input type="number" min="0" data-role="f-tmin"
                               placeholder="from" />
                        <span class="ea-bus-inspector__dash">–</span>
                        <input type="number" min="0" data-role="f-tmax"
                               placeholder="to" />
                    </div>
                </div>
            </header>
            <div class="ea-bus-inspector__scrubber" data-role="scrubber"></div>
            <div class="ea-bus-inspector__payload">
                <div class="ea-bus-inspector__caption">
                    Latest payload <span data-role="payload-cursor"></span>
                </div>
                <div class="ea-inspector__tree" data-role="payload"></div>
            </div>
            <div class="ea-bus-inspector__stream">
                <div class="ea-bus-inspector__caption">
                    Event stream
                    <span class="ea-events__counter" data-role="counter">0 events</span>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-action="clear">Clear log</button>
                </div>
                <div class="ea-bus-inspector__table" data-role="table"></div>
            </div>
        `;
        this._wireFilters();
        this._renderKinds();
    }

    _wireFilters() {
        const r = this.root;
        const topic = r.querySelector('[data-role="f-topic"]');
        topic.value = this._filter.topic;
        topic.addEventListener('input', () => {
            this._filter.topic = topic.value.trim();
            this._refresh();
        });

        const src = r.querySelector('[data-role="f-source"]');
        src.value = this._filter.source;
        src.addEventListener('input', () => {
            this._filter.source = src.value.trim().toLowerCase();
            this._refresh();
        });

        const tmin = r.querySelector('[data-role="f-tmin"]');
        const tmax = r.querySelector('[data-role="f-tmax"]');
        const parseTick = (v) => {
            const s = String(v ?? '').trim();
            if (!s) return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        };
        tmin.addEventListener('input', () => {
            this._filter.tickMin = parseTick(tmin.value);
            this._refresh();
        });
        tmax.addEventListener('input', () => {
            this._filter.tickMax = parseTick(tmax.value);
            this._refresh();
        });

        r.querySelector('[data-action="clear"]')?.addEventListener('click', async () => {
            await window.pywebview?.api?.world_event_log_clear?.();
            // The store doesn't poll, so push the reset down ourselves;
            // the next fetch will repopulate as new events arrive.
            const { reset } = await import('../event_log_store.js');
            reset();
        });
    }

    _renderKinds() {
        const host = this.root.querySelector('[data-role="f-kinds"]');
        if (!host) return;
        host.innerHTML = '';
        for (const kind of KNOWN_KINDS) {
            const on = this._filter.kinds.has(kind);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `ea-bus-inspector__kind${on ? ' ea-bus-inspector__kind--on' : ''}`;
            btn.dataset.kind = kind;
            btn.textContent = EVENT_KIND_LABEL[kind] || kind;
            btn.addEventListener('click', () => {
                if (this._filter.kinds.has(kind)) this._filter.kinds.delete(kind);
                else this._filter.kinds.add(kind);
                this._renderKinds();
                this._refresh();
            });
            host.appendChild(btn);
        }
    }

    // ----------------------------------------------------------- render

    _refresh() {
        const filtered = this._applyFilters(getEvents());
        this._eventsView = filtered;
        this._renderScrubber();
        this._renderPayload(filtered);
        this._renderStream(filtered);
    }

    _applyFilters(events) {
        const { topic, source, kinds, tickMin, tickMax } = this._filter;
        const topicQ = topic.toLowerCase();
        const out = [];
        for (const e of events) {
            if (!kinds.has(e.kind)) continue;
            if (topicQ && !String(e.topic || '').toLowerCase().includes(topicQ)) continue;
            if (source && !String(e.source || '').toLowerCase().includes(source)) continue;
            const t = Number(e.tick);
            if (tickMin != null && t < tickMin) continue;
            if (tickMax != null && t > tickMax) continue;
            out.push(e);
        }
        return out;
    }

    /** Highest tick in the (unfiltered) buffer — bounds the scrubber. */
    _scrubberMax() { return maxTick(); }

    _renderScrubber() {
        const host = this.root.querySelector('[data-role="scrubber"]');
        if (!host) return;
        // Mid-drag refresh — only update the labels, not the slider, so
        // we don't yank it out from under the user's pointer.
        if (host.querySelector('[data-role="tick-range"]') === document.activeElement) {
            this._syncScrubberLabel();
            return;
        }
        const max = this._scrubberMax();
        const live = this._cursor == null;
        const val = live ? max : Math.min(this._cursor, max);
        host.innerHTML = `
            <button type="button" class="ea-btn ea-btn--small ea-bp-bus__live${
                live ? ' ea-bp-bus__live--on' : ''}" data-action="live">
                ${live ? '● Live' : 'Go live'}
            </button>
            <input type="range" class="ea-bp-bus__range" data-role="tick-range"
                   min="0" max="${max}" value="${val}" ${max === 0 ? 'disabled' : ''} />
            <span class="ea-bp-bus__ticklabel" data-role="tick-label">${
                live ? `live · t${max}` : `viewing t${val} / ${max}`}</span>
        `;
        host.querySelector('[data-action="live"]')?.addEventListener('click', () => {
            this._cursor = null;
            // _refresh re-applies the user filters from the source
            // events; using `_eventsView` here would only show the
            // already-cursor-truncated slice from the previous render.
            this._refresh();
        });
        const range = host.querySelector('[data-role="tick-range"]');
        range?.addEventListener('input', () => {
            const v = Number(range.value);
            this._cursor = (v >= this._scrubberMax()) ? null : v;
            this._syncScrubberLabel();
            // Re-apply filters from the source buffer rather than from
            // `_eventsView`, which is the cursor-truncated render slice.
            // Scrubbing forward from a low tick has to be able to
            // surface events that were filtered out at the previous
            // cursor.
            this._refresh();
        });
    }

    _syncScrubberLabel() {
        const host = this.root.querySelector('[data-role="scrubber"]');
        if (!host) return;
        const max = this._scrubberMax();
        const live = this._cursor == null;
        const val = live ? max : Math.min(this._cursor, max);
        const label = host.querySelector('[data-role="tick-label"]');
        if (label) label.textContent = live ? `live · t${max}` : `viewing t${val} / ${max}`;
        const btn = host.querySelector('[data-action="live"]');
        if (btn) {
            btn.classList.toggle('ea-bp-bus__live--on', live);
            btn.textContent = live ? '● Live' : 'Go live';
        }
    }

    _renderPayload(filtered) {
        const host = this.root.querySelector('[data-role="payload"]');
        const label = this.root.querySelector('[data-role="payload-cursor"]');
        if (!host) return;
        // We display the latest payload from any bus.deliver event that
        // matches the filter and is at-or-before the cursor tick. If the
        // user pinned a single topic the "latest" is unambiguous; if the
        // filter spans many topics, this is the most-recent delivery of
        // any of them — which is the most useful single-value snapshot.
        const cutoff = this._cursor;
        let last = null;
        for (const e of filtered) {
            if (e.kind !== 'bus.deliver') continue;
            if (cutoff != null && Number(e.tick) > cutoff) continue;
            last = e;
        }
        if (label) {
            const max = this._scrubberMax();
            const at = cutoff == null ? max : cutoff;
            label.textContent = last
                ? `· ${last.topic} @ t${last.tick}` + (cutoff == null ? '' : ` (cursor t${at})`)
                : `· no delivery yet${cutoff == null ? '' : ` ≤ t${at}`}`;
        }
        if (!last) {
            host.innerHTML = '<div class="ea-plot__placeholder">No matching delivery.</div>';
            return;
        }
        renderInspectorTree(host, last.payload);
    }

    _renderStream(filtered) {
        const host = this.root.querySelector('[data-role="table"]');
        const counter = this.root.querySelector('[data-role="counter"]');
        if (!host) return;
        // Time-travel cap is applied on top of the user filters so the
        // displayed count matches what the table actually shows.
        const cutoff = this._cursor;
        const view = cutoff == null
            ? filtered
            : filtered.filter((e) => Number(e.tick) <= cutoff);
        this._eventsView = view;
        if (counter) {
            counter.textContent = (cutoff == null)
                ? `${view.length} event${view.length === 1 ? '' : 's'}`
                : `${view.length} of ${filtered.length} · ≤ t${cutoff}`;
        }
        const rows = view.map((e) => [
            Number(e.tick) || 0,
            EVENT_KIND_LABEL[e.kind] || e.kind || '',
            e.source || '',
            e.topic || '',
            _eventPayloadSummary(e.payload),
            (Array.isArray(e.derived_from) && e.derived_from.length > 0)
                ? e.derived_from.join(', ') : '',
        ]);
        if (this._table) {
            this._table.setData({ rows });
            return;
        }
        host.innerHTML = '';
        this._table = new DataTable(host, {
            headers: EVENT_HEADERS,
            rows,
            pageSize: 200,
            pagination: true,
            sortable: true,
            filterable: true,
            selectable: true,
            copyable: true,
            readonly: false,
            emptyMessage: 'No events match.',
            renderCell: (td, value, colIdx, rowIdx) => {
                const event = this._eventsView?.[rowIdx];
                if (!event) return false;
                if (colIdx === EVENT_COL.TICK) {
                    td.textContent = `t${event.tick}`;
                    td.classList.add('ea-events-row__tick');
                    return true;
                }
                if (colIdx === EVENT_COL.SOURCE || colIdx === EVENT_COL.TOPIC) {
                    const code = document.createElement('code');
                    code.textContent = value || '';
                    td.appendChild(code);
                    return true;
                }
                if (colIdx === EVENT_COL.PAYLOAD) {
                    const code = document.createElement('code');
                    code.textContent = value || '';
                    td.appendChild(code);
                    return true;
                }
                if (colIdx === EVENT_COL.DERIVED) {
                    const ids = Array.isArray(event.derived_from) ? event.derived_from : [];
                    for (const id of ids) {
                        const chip = document.createElement('span');
                        chip.className = 'ea-events-row__from';
                        chip.textContent = `#${id}`;
                        td.appendChild(chip);
                        td.appendChild(document.createTextNode(' '));
                    }
                    return true;
                }
                return false;
            },
        });
        // DataTable's constructor only initializes state — nothing
        // appears in the DOM until render() is called. Without this,
        // the table is invisible on first paint and only materializes
        // once setData (which calls render internally) runs, e.g. when
        // the user touches the scrubber.
        this._table.render();
    }
}


function _eventPayloadSummary(node) {
    if (!node) return '—';
    if (node.kind === 'primitive') {
        if (node.value == null) return 'null';
        if (typeof node.value === 'string') return JSON.stringify(node.value);
        if (typeof node.value === 'number') {
            return Number(node.value).toFixed(4).replace(/\.?0+$/, '');
        }
        return String(node.value);
    }
    if (node.kind === 'list')   return `[${node.length} items]`;
    if (node.kind === 'dict')   return `{${node.length} keys}`;
    if (node.kind === 'object') return `<${node.type}>`;
    if (node.kind === 'repr')   return node.repr || '';
    if (node.kind === 'elided') return '…';
    return '';
}
