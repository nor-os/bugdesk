/**
 * LiteratureCell — bibliography with CRUD and cross-file aggregation.
 *
 * Tabs:
 *   Config  — add/edit/delete this cell's own bibliography entries
 *   Display — formatted bibliography list merging local + aggregated entries
 *
 * Data model:
 *   {
 *     entries: [
 *       { citeKey: 'meadows1972', type: 'book', authors: 'Meadows et al.', title: 'Limits to Growth', year: 1972, publisher: 'Universe Books' },
 *       { citeKey: 'nordhaus2017', type: 'article', authors: 'Nordhaus, W.', title: 'DICE model', year: 2017, journal: 'PNAS', volume: '114(7)' }
 *     ]
 *   }
 *
 * Aggregation hierarchy:
 *   namespace  →  local entries only
 *   scenario   →  local + all namespace literature entries (deduplicated by citeKey)
 *   paper      →  local + all scenario + all namespace literature entries (deduplicated)
 *
 * Citation referencing: documentation cells can reference entries with [@citeKey].
 * Citation scanning spans all aggregated documentation cells.
 */

import { CellBase } from './cell_base.js';
import { collectFromNamespaces, collectFromScenarios } from './cross_file_collector.js';

const ENTRY_TYPES = ['article', 'book', 'inproceedings', 'techreport', 'misc'];

export class LiteratureCell extends CellBase {

    /** @type {HTMLElement} */
    #configEl = null;

    /** @type {HTMLElement} */
    #displayEl = null;

    /** @type {Map<string, number>} citeKey → citation number (1-based) */
    #citationMap = new Map();

    /** @type {Array<{ entry: object, source: string }>} merged entries with provenance */
    #aggregatedEntries = [];

    /** @type {number} generation counter to discard stale async results */
    #generation = 0;

    _getTabs() {
        return [
            { id: 'config', label: 'Edit' },
            { id: 'display', label: 'Bibliography' },
        ];
    }

    async renderBody(bodyEl) {
        bodyEl.innerHTML = `
            <div class="literature-cell__config" data-panel="config">
                <div class="literature-cell__entry-list"></div>
                <button class="literature-cell__add-btn" type="button">+ Add entry</button>
            </div>
            <div class="literature-cell__display" data-panel="display">
                <div class="literature-cell__bib-list"></div>
            </div>
        `;

        this.#configEl = bodyEl.querySelector('.literature-cell__config');
        this.#displayEl = bodyEl.querySelector('.literature-cell__display');

        this.#configEl.querySelector('.literature-cell__add-btn')
            .addEventListener('click', () => this.#addEntry());

        this.#renderEntryList();
        this.#buildLocalCitationMap();
        this.#renderBibliography();
        this._onTabChanged(this._activeTab);
        this.#rebuildAsync();
    }

    getData() {
        return { ...this._cell.data };
    }

    refreshContent() {
        this.#rebuildCitationMap();
        this.#renderBibliography();
    }

    _onTabChanged(tabId) {
        if (this.#configEl) this.#configEl.toggleAttribute('hidden', tabId !== 'config');
        if (this.#displayEl) this.#displayEl.toggleAttribute('hidden', tabId !== 'display');
    }

    // ─── Entry CRUD ─────────────────────────────────────────────────────────

    #addEntry() {
        const entries = this._cell.data.entries ?? [];
        entries.push({
            citeKey: `ref${entries.length + 1}`,
            type: 'article',
            authors: '',
            title: '',
            year: new Date().getFullYear(),
            journal: '',
            publisher: '',
            volume: '',
        });
        this._notifyChange({ entries: [...entries] });
        this.#renderEntryList();
    }

    #deleteEntry(index) {
        const entries = [...(this._cell.data.entries ?? [])];
        entries.splice(index, 1);
        this._notifyChange({ entries });
        this.#renderEntryList();
        this.#rebuildAsync();
    }

    #updateEntry(index, field, value) {
        const entries = [...(this._cell.data.entries ?? [])];
        entries[index] = { ...entries[index], [field]: value };
        this._notifyChange({ entries });
    }

    #renderEntryList() {
        const listEl = this.#configEl?.querySelector('.literature-cell__entry-list');
        if (!listEl) return;

        const localEntries = this._cell.data.entries ?? [];

        // Inherited entries from cross-file aggregation (read-only)
        const inherited = this.#aggregatedEntries.filter(ae => ae.source !== null);

        let html = '';

        if (inherited.length > 0) {
            html += inherited.map(({ entry, source }) => `
                <div class="literature-cell__entry literature-cell__entry--inherited">
                    <div class="literature-cell__entry-row">
                        <span class="literature-cell__inherited-key">${this.#esc(entry.citeKey ?? '')}</span>
                        <span class="literature-cell__source-badge">${this.#esc(source)}</span>
                    </div>
                    <div class="literature-cell__inherited-summary">
                        ${this.#formatEntry(entry)}
                    </div>
                </div>
            `).join('');
        }

        if (localEntries.length === 0 && inherited.length === 0) {
            html += '<div class="literature-cell__empty">No bibliography entries. Click "+ Add entry" to begin.</div>';
        } else if (localEntries.length === 0) {
            html += '<div class="literature-cell__local-header">No local entries</div>';
        }

        html += localEntries.map((entry, i) => `
            <div class="literature-cell__entry" data-index="${i}">
                <div class="literature-cell__entry-row">
                    <label>Key</label>
                    <input type="text" class="literature-cell__input" data-field="citeKey" value="${this.#esc(entry.citeKey ?? '')}">
                    <label>Type</label>
                    <select class="literature-cell__input" data-field="type">
                        ${ENTRY_TYPES.map(t => `<option value="${t}" ${t === entry.type ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <button class="literature-cell__delete-btn" data-index="${i}" title="Delete">&times;</button>
                </div>
                <div class="literature-cell__entry-row">
                    <label>Authors</label>
                    <input type="text" class="literature-cell__input" data-field="authors" value="${this.#esc(entry.authors ?? '')}" placeholder="Last, First; Last, First">
                </div>
                <div class="literature-cell__entry-row">
                    <label>Title</label>
                    <input type="text" class="literature-cell__input" data-field="title" value="${this.#esc(entry.title ?? '')}">
                    <label>Year</label>
                    <input type="number" class="literature-cell__input literature-cell__year" data-field="year" value="${entry.year ?? ''}">
                </div>
                <div class="literature-cell__entry-row">
                    <label>Journal / Publisher</label>
                    <input type="text" class="literature-cell__input" data-field="journal" value="${this.#esc(entry.journal || entry.publisher || '')}">
                    <label>Volume</label>
                    <input type="text" class="literature-cell__input literature-cell__volume" data-field="volume" value="${this.#esc(entry.volume ?? '')}">
                </div>
            </div>
        `).join('');

        listEl.innerHTML = html;

        // Bind events on local (editable) entries
        listEl.querySelectorAll('.literature-cell__entry:not(.literature-cell__entry--inherited)').forEach(entryEl => {
            const idx = parseInt(entryEl.dataset.index, 10);
            if (isNaN(idx)) return;
            entryEl.querySelectorAll('input, select').forEach(input => {
                input.addEventListener('change', () => {
                    const val = input.type === 'number' ? parseInt(input.value, 10) : input.value;
                    this.#updateEntry(idx, input.dataset.field, val);
                });
            });
        });

        listEl.querySelectorAll('.literature-cell__delete-btn').forEach(btn => {
            btn.addEventListener('click', () => this.#deleteEntry(parseInt(btn.dataset.index, 10)));
        });
    }

    // ─── Cross-file aggregation ──────────────────────────────────────────────

    async #rebuildAsync() {
        const fileType = this._props?.fileType;
        if (fileType === 'namespace') return;

        const project = this._props?.project;
        if (!project) return;

        const gen = ++this.#generation;

        const { mergedEntries, allDocCells } = await this.#collectAggregatedData(project, fileType);
        if (gen !== this.#generation) return; // stale

        this.#aggregatedEntries = mergedEntries;
        this.#buildCitationMap(allDocCells);
        this.#renderEntryList();
        this.#renderBibliography();
    }

    async #collectAggregatedData(project, fileType) {
        const seen = new Map(); // citeKey → { entry, source }
        const allDocCells = [];

        // Collect from namespaces (always, for both scenario and paper)
        const nsResults = await collectFromNamespaces(project, c => c.type === 'literature' || c.type === 'documentation');
        for (const { name, cells } of nsResults) {
            for (const cell of cells) {
                if (cell.type === 'literature') {
                    for (const entry of (cell.data?.entries ?? [])) {
                        const key = entry.citeKey ?? entry.id;
                        if (key && !seen.has(key)) {
                            seen.set(key, { entry, source: name });
                        }
                    }
                } else if (cell.type === 'documentation') {
                    allDocCells.push(cell);
                }
            }
        }

        // For paper: also collect from scenarios
        if (fileType === 'paper') {
            const scResults = await collectFromScenarios(project, c => c.type === 'literature' || c.type === 'documentation');
            for (const { name, cells } of scResults) {
                for (const cell of cells) {
                    if (cell.type === 'literature') {
                        for (const entry of (cell.data?.entries ?? [])) {
                            const key = entry.citeKey ?? entry.id;
                            if (key && !seen.has(key)) {
                                seen.set(key, { entry, source: name });
                            }
                        }
                    } else if (cell.type === 'documentation') {
                        allDocCells.push(cell);
                    }
                }
            }
        }

        // Add local entries last (local additions take lowest priority for dedup)
        const localEntries = this._cell.data.entries ?? [];
        for (const entry of localEntries) {
            const key = entry.citeKey;
            if (key && !seen.has(key)) {
                seen.set(key, { entry, source: null }); // null = local
            }
        }

        // Also include sibling documentation cells for citation scanning
        const siblingCells = this._props?.getCells?.() ?? [];
        for (const cell of siblingCells) {
            if (cell.type === 'documentation') {
                allDocCells.push(cell);
            }
        }

        return {
            mergedEntries: [...seen.values()],
            allDocCells,
        };
    }

    // ─── Citation map ───────────────────────────────────────────────────────

    /** Build citation map from local entries only (sync, for initial render). */
    #buildLocalCitationMap() {
        const cells = this._props?.getCells?.() ?? [];
        const entries = this._cell.data.entries ?? [];
        this.#buildCitationMapFrom(entries, cells);
    }

    /** Build citation map from full aggregated data (async callback). */
    #buildCitationMap(allDocCells) {
        const entries = this.#aggregatedEntries.map(ae => ae.entry);
        this.#buildCitationMapFrom(entries, allDocCells);
    }

    /** Rebuild citation map using best available data (aggregated if present, local otherwise). */
    #rebuildCitationMap() {
        if (this.#aggregatedEntries.length > 0) {
            const entries = this.#aggregatedEntries.map(ae => ae.entry);
            const docCells = this._props?.getCells?.()?.filter(c => c.type === 'documentation') ?? [];
            this.#buildCitationMapFrom(entries, docCells);
        } else {
            this.#buildLocalCitationMap();
        }
    }

    #buildCitationMapFrom(entries, docCells) {
        this.#citationMap.clear();

        const knownKeys = new Set(entries.map(e => e.citeKey ?? e.id));

        // Scan documentation cells for [@key] patterns
        const referenced = new Set();
        const citePattern = /\[@([^\]]+)\]/g;
        for (const cell of docCells) {
            if (cell.type !== 'documentation') continue;
            const src = cell.data?.source ?? '';
            let match;
            while ((match = citePattern.exec(src)) !== null) {
                const key = match[1].trim();
                if (knownKeys.has(key)) referenced.add(key);
            }
        }

        // Number referenced entries first (in order of appearance)
        let num = 0;
        for (const entry of entries) {
            const key = entry.citeKey ?? entry.id;
            if (referenced.has(key)) {
                num++;
                this.#citationMap.set(key, num);
            }
        }

        // Unreferenced entries get numbers after referenced ones
        for (const entry of entries) {
            const key = entry.citeKey ?? entry.id;
            if (!this.#citationMap.has(key)) {
                num++;
                this.#citationMap.set(key, num);
            }
        }
    }

    // ─── Bibliography display ───────────────────────────────────────────────

    #renderBibliography() {
        const bibEl = this.#displayEl?.querySelector('.literature-cell__bib-list');
        if (!bibEl) return;

        const fileType = this._props?.fileType;
        const isAggregate = fileType !== 'namespace';

        // Use aggregated entries if available, otherwise fall back to local
        const displayEntries = isAggregate && this.#aggregatedEntries.length > 0
            ? this.#aggregatedEntries
            : (this._cell.data.entries ?? []).map(e => ({ entry: e, source: null }));

        if (displayEntries.length === 0) {
            bibEl.innerHTML = '<div class="literature-cell__empty">No entries</div>';
            return;
        }

        // Sort by citation number
        const sorted = [...displayEntries].sort((a, b) => {
            const keyA = a.entry.citeKey ?? a.entry.id;
            const keyB = b.entry.citeKey ?? b.entry.id;
            return (this.#citationMap.get(keyA) ?? 999) - (this.#citationMap.get(keyB) ?? 999);
        });

        bibEl.innerHTML = sorted.map(({ entry, source }) => {
            const key = entry.citeKey ?? entry.id;
            const num = this.#citationMap.get(key) ?? '?';
            const badge = source
                ? `<span class="literature-cell__source-badge">${this.#esc(source)}</span>`
                : '';
            return `
                <div class="literature-cell__bib-entry">
                    <span class="literature-cell__bib-num">[${num}]</span>
                    <span class="literature-cell__bib-text">
                        ${this.#formatEntry(entry)}${badge}
                    </span>
                </div>
            `;
        }).join('');
    }

    #formatEntry(entry) {
        const parts = [];
        if (entry.authors) parts.push(this.#esc(entry.authors));
        if (entry.year) parts.push(`(${entry.year})`);
        if (entry.title) parts.push(`<em>${this.#esc(entry.title)}</em>`);
        if (entry.journal) parts.push(this.#esc(entry.journal));
        if (entry.publisher) parts.push(this.#esc(entry.publisher));
        if (entry.volume) parts.push(this.#esc(entry.volume));
        return parts.join('. ') + '.';
    }

    #esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    dispose() {
        this.#configEl = null;
        this.#displayEl = null;
        this.#citationMap.clear();
        this.#aggregatedEntries = [];
        super.dispose();
    }
}
