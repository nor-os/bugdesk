/**
 * NotebookDslCompiler
 *
 * Compiles namespace cells + scenario into a single EcoLang DSL string for the
 * simulation backend.
 *
 * Input:
 *   - namespaceCells:  [{ namespace: 'Main', cells: [...] }, ...] from .namespace files
 *   - scenarioData:    structured scenario data (solver, time, overrides)
 *
 * Output:
 *   - dsl: string  (full EcoLang DSL ready for the backend)
 *   - sourceMap: array of { dslLine, fileName, cellId, cellType, cellLine } per DSL line
 *   - solver: { method, rtol, atol }
 *   - time:   { t0, t1, dt }
 *   - monteCarlo: null | { runs, seed }
 *
 * DSL compilation rules per cell type:
 *   code      → emitted verbatim
 *   parameter → "name = value"  (with optional comment for range/distribution)
 *   godley    → delegated to existing Godley DSL emitter
 *   documentation, plot → no DSL output
 *
 * Each namespace's cells are preceded by `namespace <Name>` in the DSL output.
 */

/**
 * @typedef {{
 *   dslLine: number,
 *   fileName: string|null,
 *   cellId: string|null,
 *   cellType: string|null,
 *   cellLine: number,
 * }} SourceMapEntry
 */

export class NotebookDslCompiler {

    /**
     * Compile namespace cells + scenario into a run configuration.
     *
     * @param {{
     *   namespaceCells?: { namespace: string, fileName?: string, cells: object[] }[],
     *   scenarioData?: object,
     * }} input
     * @returns {{
     *   dsl: string,
     *   sourceMap: SourceMapEntry[],
     *   solver: { method: string, rtol: number, atol: number },
     *   time: { t0: number, t1: number, dt: number },
     *   monteCarlo: null | { runs: number, seed: number | null },
     *   distributions: object,
     *   scenarioType: string,
     *   execution: object | null,
     * }}
     */
    compile({ namespaceCells = [], scenarioData = {}, moduleSources = [] }) {
        const solver = this.#resolveSolver(scenarioData.solver);
        const time   = this.#resolveTime(scenarioData.time);
        const monteCarlo = scenarioData.monteCarlo ?? null;
        const scenarioDistributions = scenarioData.distributions ?? {};
        // Derive type from monteCarlo.runs as authoritative source
        const hasMC = (monteCarlo?.runs ?? 0) > 0;
        const scenarioType = hasMC ? 'monte-carlo' : (scenarioData.type ?? 'static');
        const execution = scenarioData.execution ?? null;
        const paramOverrides = new Map();
        /** @type {Map<string, object>} Collected from parameter cells: "Namespace.paramName" → distribution */
        const cellDistributions = new Map();

        // Flatten structured overrides: { namespace: { bucket: { name: value | { value?, min?, max?, distribution? } } } }
        // Also collects distribution overrides into overrideDistributions.
        /** @type {Map<string, object>} "Namespace.paramName" → distribution from overrides */
        const overrideDistributions = new Map();
        const overrides = scenarioData.overrides ?? {};
        for (const [nsKey, ns] of Object.entries(overrides)) {
            for (const category of ['parameters', 'constants', 'stocks', 'inputs']) {
                const items = ns[category];
                if (!items || typeof items !== 'object') continue;
                for (const [name, entry] of Object.entries(items)) {
                    if (entry === undefined || entry === null) continue;
                    // Handle both plain number and extended { value?, min?, max?, distribution? }
                    if (typeof entry === 'number' || typeof entry === 'string') {
                        paramOverrides.set(name, String(entry));
                    } else if (typeof entry === 'object') {
                        if (entry.value !== undefined) {
                            paramOverrides.set(name, String(entry.value));
                        }
                        // Extract distribution override
                        if (entry.distribution?.type && entry.distribution.type !== 'none') {
                            overrideDistributions.set(
                                `${nsKey}.${name}`,
                                this.#normalizeDistribution(entry.distribution),
                            );
                        }
                    }
                }
            }
        }

        // ── Build DSL sections per namespace with source map ─────────────
        /** @type {SourceMapEntry[]} */
        const sourceMap = [];
        const dslLines = [];
        let dslLineNum = 1; // 1-based

        // ── Prepend module definitions (.edf files) ──────────────────────
        for (const { fileName, source } of moduleSources) {
            if (!source?.trim()) continue;
            const lines = source.split('\n');
            for (const line of lines) {
                dslLines.push(line);
                sourceMap.push({ dslLine: dslLineNum, fileName: fileName ?? null, cellId: null, cellType: 'module', cellLine: 0 });
                dslLineNum++;
            }
            dslLines.push('', '');
            sourceMap.push({ dslLine: dslLineNum, fileName: null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;
            sourceMap.push({ dslLine: dslLineNum, fileName: null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;
        }

        for (const { namespace: nsName, fileName, cells } of namespaceCells) {
            const nsSections = [];

            for (const cell of cells) {
                const section = this.#compileCell(cell, paramOverrides);
                if (section) {
                    nsSections.push({ text: section, cell, fileName: fileName ?? null });
                }
                // Collect distributions from parameter cells
                if (cell.type === 'parameter') {
                    const params = cell.data?.parameters ?? (cell.data?.name ? [cell.data] : []);
                    for (const p of params) {
                        const name = p.name?.trim();
                        if (!name) continue;
                        if (p.distribution?.type && p.distribution.type !== 'none') {
                            cellDistributions.set(
                                `${nsName}.${name}`,
                                this.#normalizeDistribution(p.distribution),
                            );
                        }
                    }
                }
            }

            if (nsSections.length === 0) continue;

            // Emit `.NAMESPACE <Name>` header
            const nsHeader = `.NAMESPACE ${nsName}`;
            dslLines.push(nsHeader, '');
            sourceMap.push({ dslLine: dslLineNum, fileName: fileName ?? null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;
            sourceMap.push({ dslLine: dslLineNum, fileName: fileName ?? null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;

            for (let si = 0; si < nsSections.length; si++) {
                const { text, cell, fileName: fn } = nsSections[si];
                const lines = text.split('\n');

                for (let li = 0; li < lines.length; li++) {
                    dslLines.push(lines[li]);
                    sourceMap.push({
                        dslLine: dslLineNum,
                        fileName: fn,
                        cellId: cell.id ?? null,
                        cellType: cell.type ?? null,
                        cellLine: li + 1, // 1-based line within the cell's compiled output
                    });
                    dslLineNum++;
                }

                // Blank line between sections
                if (si < nsSections.length - 1) {
                    dslLines.push('');
                    sourceMap.push({ dslLine: dslLineNum, fileName: fn, cellId: null, cellType: null, cellLine: 0 });
                    dslLineNum++;
                }
            }

            // Blank lines between namespaces
            dslLines.push('', '');
            sourceMap.push({ dslLine: dslLineNum, fileName: null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;
            sourceMap.push({ dslLine: dslLineNum, fileName: null, cellId: null, cellType: null, cellLine: 0 });
            dslLineNum++;
        }

        const dsl = dslLines.join('\n');

        // Merge distributions: cell-level defaults → scenario distributions → override distributions (highest priority).
        // All use flat keys: "Namespace.paramName" → { type, min, max, ... }
        const distributions = Object.fromEntries(cellDistributions);
        for (const [key, dist] of Object.entries(scenarioDistributions)) {
            distributions[key] = dist;
        }
        for (const [key, dist] of overrideDistributions) {
            distributions[key] = dist;
        }

        console.log(`[DSL Compiler] cellDistributions=${cellDistributions.size}, scenarioDistributions=${Object.keys(scenarioDistributions).length}, overrideDistributions=${overrideDistributions.size}, total=${Object.keys(distributions).length}, scenarioType=${scenarioType}`);

        return { dsl, sourceMap, solver, time, monteCarlo, distributions, scenarioType, execution };
    }

    /**
     * Look up source location for a DSL line number.
     * @param {SourceMapEntry[]} sourceMap
     * @param {number} dslLine  1-based
     * @returns {SourceMapEntry|null}
     */
    static lookupLine(sourceMap, dslLine) {
        return sourceMap.find(e => e.dslLine === dslLine) ?? null;
    }

    // ─── Cell compilation ──────────────────────────────────────────────────────

    #compileCell(cell, paramOverrides) {
        switch (cell.type) {
            case 'code':
                return this.#compileCodeCell(cell, paramOverrides);
            case 'parameter':
                return this.#compileParameterCell(cell, paramOverrides);
            case 'godley':
                return this.#compileGodleyCell(cell);
            case 'generator':
                return this.#compileSpecialCell(cell);
            case 'smooth':
                return this.#compileSmoothCell(cell);
            case 'pid':
                return this.#compilePidCell(cell);
            case 'schedule':
                return this.#compileScheduleCell(cell);
            case 'conditional-switch':
                return this.#compileConditionalSwitchCell(cell);
            case 'delay':
                return this.#compileDelayCell(cell);
            case 'latch':
                return this.#compileLatchCell(cell);
            case 'time':
                return this.#compileTimeCell(cell);
            case 'signal-source':
                return this.#compileSignalSourceCell(cell);
            case 'event-timer':
                return this.#compileEventTimerCell(cell);
            case 'event-counter':
                return this.#compileEventCounterCell(cell);
            case 'linear-ramp':
                return this.#compileLinearRampCell(cell);
            case 'statistics':
                return this.#compileStatisticsCell(cell);
            case 'stock':
                return this.#compileStockCell(cell);
            case 'source-sink':
                return this.#compileSourceSinkCell(cell);
            case 'documentation':
            case 'plot':
            case 'heading':
            case 'stock-viewer':
                return null; // No DSL output
            default:
                return null;
        }
    }

    #compileCodeCell(cell, paramOverrides) {
        let source = cell.data?.source ?? '';
        if (!source.trim()) return null;

        // Apply parameter overrides: replace "name = <old>" with "name = <override>"
        // Only at the start of a line (lhs assignment), not inside expressions
        for (const [name, value] of paramOverrides) {
            const pattern = new RegExp(`^(${this.#escapeRegex(name)}\\s*=\\s*)(.+)`, 'gm');
            source = source.replace(pattern, `$1${value}  ; [scenario override]`);
        }

        return source;
    }

    #compileParameterCell(cell, paramOverrides) {
        const data = cell.data ?? {};
        // Support multi-param ({ parameters: [...] }) and legacy single-param ({ name, value })
        const params = data.parameters ?? (data.name ? [data] : []);
        const lines = [];

        for (const p of params) {
            const name = p.name?.trim();
            if (!name) continue;

            const value = paramOverrides.has(name) ? paramOverrides.get(name) : (p.value ?? '0');
            const line = `${name} = ${value}`;
            lines.push(line);
            if (p.description) {
                const descLines = p.description.split('\n');
                for (const dl of descLines) {
                    lines.push(`; ${dl}`);
                }
            }

            if (p.min !== undefined && p.min !== '' && p.max !== undefined && p.max !== '') {
                lines.push(`; range: [${p.min}, ${p.max}]`);
            }

            if (p.distribution?.type && p.distribution.type !== 'none') {
                const dist = p.distribution;
                const distParams = Object.entries(dist)
                    .filter(([k]) => k !== 'type')
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                lines.push(`; mc_distribution: ${dist.type}(${distParams})`);
            }
        }

        return lines.length ? lines.join('\n') : null;
    }

    #compileGodleyCell(cell) {
        const data = cell.data ?? {};
        const ns = data.sector?.trim();
        const title = data.title?.trim() ?? 'Untitled';

        if (!ns) return null;

        const lines = [`; Godley Table: ${title}`];

        if (Array.isArray(data.flows) && Array.isArray(data.accounts)) {
            // New format: accounts = [{ id, name, type }], flows = [{ id, name, entries: { accId: expr } }]

            // Emit stock initial values
            const emittedInits = new Set();
            for (const acc of data.accounts) {
                const initVal = acc.initialValue;
                if (initVal == null || initVal === '') continue;
                const key = `${acc.type}[${acc.name}]`;
                if (emittedInits.has(key)) continue;
                emittedInits.add(key);
                lines.push(`${ns}::${key} = ${initVal}`);
            }

            // Group flow expressions by account → one equation per account
            const byAccount = new Map();
            for (const flow of data.flows) {
                for (const acc of data.accounts) {
                    const expr = flow.entries?.[acc.id]?.trim();
                    if (!expr) continue;
                    const key = `${acc.type}[${acc.name}]`;
                    if (!byAccount.has(key)) byAccount.set(key, []);
                    byAccount.get(key).push(expr);
                }
            }
            for (const [key, exprs] of byAccount) {
                lines.push(`d${ns}::${key}/dt = ${exprs.join(' + ')}`);
            }
        } else if (Array.isArray(data.rows) && Array.isArray(data.cols)) {
            // Legacy format: cols = account names, rows = [{ label, entries: { accountName: expr } }]
            for (const row of data.rows) {
                if (!row.label || row.label === '_sum') continue;
                for (const account of data.cols) {
                    const expr = row.entries?.[account];
                    if (!expr?.trim()) continue;
                    lines.push(`d${ns}::Assets[${account}]/dt += ${expr}`);
                }
            }
        }

        return lines.length > 1 ? lines.join('\n') : null;
    }

    #compileSpecialCell(cell) {
        // Generator cell: name = generator("waveform", field=val, ...)
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'signal';
        const waveform = d.waveform || 'sine';

        const WAVEFORM_FIELDS = {
            sine:  ['amplitude', 'frequency', 'phase', 'offset'],
            step:  ['amplitude', 'delay', 'offset'],
            ramp:  ['amplitude', 'delay', 'offset'],
            pulse: ['amplitude', 'delay', 'duration', 'offset'],
            noise: ['amplitude', 'seed', 'offset'],
        };
        const FIELD_DEFAULTS = {
            amplitude: '1', frequency: '1', phase: '0', offset: '0',
            delay: '0', duration: '1', seed: '42',
        };
        const fields = WAVEFORM_FIELDS[waveform] ?? [];
        const params = fields.map(f => `${f}=${d[f] ?? FIELD_DEFAULTS[f]}`).join(', ');
        return `${name} = generator("${waveform}", ${params})`;
    }

    #compileSmoothCell(cell) {
        // Smooth/delay cell: name = smooth(input, dt, order) or delay3(input, dt)
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'smoothed_value';
        const input  = d.input?.trim() || '0';
        const dt     = d.delayTime || '5';
        const init   = d.initialValue?.trim() ? `, ${d.initialValue}` : '';

        if (d.func === 'delay3') {
            return `${name} = delay3(${input}, ${dt}${init})`;
        }
        const order = d.order || '1';
        return `${name} = ${d.func || 'smooth'}(${input}, ${dt}, ${order}${init})`;
    }

    #compilePidCell(cell) {
        // PID controller cell: name = pid(input, setpoint, Kp, Ki, Kd)
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'pid_output';
        const input  = d.input?.trim() || '0';
        return `${name} = pid(${input}, ${d.setpoint || '0'}, ${d.kp || '1'}, ${d.ki || '0'}, ${d.kd || '0'})`;
    }

    #compileScheduleCell(cell) {
        // Schedule cell: name = schedule(input, x0, y0, x1, y1, ...)
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'schedule_output';
        const input  = d.input?.trim() || 'x';
        const points = Array.isArray(d.points) ? d.points : [];
        const pairs  = points.flatMap(pt => [pt.x || '0', pt.y || '0']).join(', ');
        const mode   = d.interpolation === 'step' ? ', "step"' : '';
        return `${name} = schedule(${input}, ${pairs}${mode})`;
    }

    #compileConditionalSwitchCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'switch_output';
        const steepness = d.steepness || '20';
        const rules  = Array.isArray(d.rules) ? d.rules : [];
        const elseVal = d.elseValue ?? '0';

        const arms = rules
            .filter(r => r.leftExpr?.trim() && r.output?.trim())
            .map(r => `| when ${r.leftExpr} ${r.operator || '>'} ${r.rightExpr} -> ${r.output}`);
        arms.push(`| _ -> ${elseVal}`);

        return `${name} = match using steepness=${steepness} with ${arms.join(' ')}`;
    }

    #compileDelayCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'delayed_value';
        const input  = d.input?.trim() || '0';
        const lag    = d.lagAmount || '5';
        const parts  = [input, lag];
        if (d.defaultVal?.trim()) parts.push(d.defaultVal);
        if (d.initVal?.trim())    parts.push(d.initVal);
        return `${name} = lag(${parts.join(', ')})`;
    }

    #compileLatchCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'latched';
        const cond   = d.condition?.trim() || '0';
        const parts  = [cond];
        if (d.resetCondition?.trim()) parts.push(d.resetCondition);
        if (d.initial?.trim())        parts.push(d.initial);
        return `${name} = latch(${parts.join(', ')})`;
    }

    #compileTimeCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'time_var';
        const expr   = d.expression?.trim() || 't';
        return `${name} = ${expr}`;
    }

    #compileSignalSourceCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'signal_output';
        const outVar = name;

        const seriesId = d.seriesId || '';
        const timeCol  = d.timeColumn || '';
        const valCol   = d.valueColumn || '';

        if (!seriesId && !d.datasetName) return `${outVar} = 0  ; signal source not configured`;
        if (!timeCol || !valCol) return `${outVar} = 0  ; signal source not configured`;

        let suffix = `, interpolation="${d.interpolation || 'linear'}", extrapolation="${d.extrapolation || 'hold'}"`;

        const offset = parseFloat(d.timeOffset) || 0;
        if (offset !== 0) suffix += `, time_offset=${offset}`;
        if (d.timeMapping && d.timeMapping !== 'numeric') suffix += `, time_mapping="${d.timeMapping}"`;

        if (d.groupByColumn) {
            suffix += `, group_by_column="${d.groupByColumn}", aggregation_function="${d.aggregationFunction || 'sum'}"`;
            if (d.groupFilter) suffix += `, group_filter="${d.groupFilter}"`;
        }

        if (d.datasetName && !seriesId) {
            suffix += `, dataset_name="${d.datasetName}"`;
        }

        const TREND_IDS = ['local_trend', 'linear_trend', 'linear_regression', 'exponential', 'polynomial', 'moving_average', 'log_linear', 'power'];
        const isTrend = TREND_IDS.includes(d.extrapolation);
        if (isTrend) {
            const window = parseInt(d.extrapolationWindow) || 0;
            suffix += `, extrap_method="${d.extrapolation}", extrap_window=${window}`;
            if (d.extrapolation === 'polynomial') {
                suffix += `, extrap_degree=${parseInt(d.polynomialDegree) || 2}`;
            }
            const extrapVar = `${outVar}_extrap`;
            return `${outVar}, ${extrapVar} = signal(t, "${seriesId}", "${timeCol}", "${valCol}"${suffix})`;
        }

        return `${outVar} = signal(t, "${seriesId}", "${timeCol}", "${valCol}"${suffix})`;
    }

    #compileEventTimerCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'timer_trigger';
        const cond   = d.condition?.trim() || '0';
        const dur    = d.duration || '5';
        const mode   = d.mode || 'sustain';

        let args = `${cond}, ${dur}`;
        if (mode !== 'sustain') args += `, "${mode}"`;

        return `${name} = timer(${args})`;
    }

    #compileEventCounterCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'crossing_count';
        const cond   = d.condition?.trim() || '0';
        const thresh = d.threshold || '0';
        const reset  = d.resetCondition?.trim();

        let args = cond;
        if (thresh !== '0' || reset) {
            args += `, ${thresh}`;
            if (reset) args += `, ${reset}`;
        }

        return `${name} = counter(${args})`;
    }

    #compileLinearRampCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'ramp_signal';

        if (d.generatorType === 'ramp') {
            const s = d.startValue || '0';
            const e = d.endValue || '1';
            const t0 = d.startTime || '0';
            return `${name} = generator("ramp", amplitude=${e} - ${s}, delay=${t0}, offset=${s})`;
        }

        // Random mode
        if (d.randomDistribution === 'uniform') {
            const lo = d.randomMin || '0';
            const hi = d.randomMax || '1';
            const seed = d.randomSeed || '42';
            return `${name} = generator("noise", amplitude=(${hi} - ${lo}) / 2, seed=${seed}, offset=(${hi} + ${lo}) / 2)`;
        }

        const mean = d.randomMean || '0';
        const std = d.randomStdDev || '1';
        const seed = d.randomSeed || '42';
        return `${name} = generator("noise", amplitude=${std}, seed=${seed}, offset=${mean})`;
    }

    #compileStatisticsCell(cell) {
        const d = cell.data ?? {};
        const name   = d.name?.trim()  || 'stat_output';
        const input  = d.input?.trim() || 'x';
        const fn     = d.functionType || 'rolling_mean';

        switch (fn) {
            case 'rolling_mean':
            case 'rolling_std':
            case 'rolling_min':
            case 'rolling_max':
                return `${name} = ${fn}(${input}, ${d.windowSize || '5'})`;
            case 'ema':
                return `${name} = ema(${input}, ${d.alpha || '0.3'})`;
            case 'cumsum':
                return `${name} = cumsum(${input})`;
            default:
                return `${name} = ${fn}(${input})`;
        }
    }

    // ─── Settings resolution ────────────────────────────────────────────────────

    #resolveSolver(solver = {}) {
        return {
            method: solver?.method ?? 'RK45',
            rtol:   solver?.rtol   ?? 1e-3,
            atol:   solver?.atol   ?? 1e-6,
        };
    }

    #resolveTime(time = {}) {
        return {
            t0: time?.t0 ?? 0,
            t1: time?.t1 ?? 100,
            dt: time?.dt ?? 0.25,
        };
    }

    // ─── Stock / Source-Sink cells ───────────────────────────────────────────

    #wrapDelay(expr, delay) {
        if (!delay?.enabled || !expr?.trim()) return expr;
        const time = delay.time || '1';
        switch (delay.type) {
            case 'delay3': return `delay3(${expr}, ${time})`;
            case 'smooth': return `smooth(${expr}, ${time}, ${delay.order || '1'})`;
            case 'lag':    return `lag(${expr}, ${time})`;
            default:       return expr;
        }
    }

    #compileStockCell(cell) {
        const d = cell.data ?? {};
        const name = d.name?.trim() || 'x';
        const init = d.initialValue?.trim() || '0';
        const expr = d.expression?.trim() || '0';
        const wrapped = this.#wrapDelay(expr, d.delay);
        return `${name} = ${init}\nd${name}/dt = ${wrapped}`;
    }

    #compileSourceSinkCell(cell) {
        const d = cell.data ?? {};
        const name = d.name?.trim() || 'x';
        const init = d.initialValue?.trim() || '0';
        const srcRaw = d.source?.trim();
        const snkRaw = d.sink?.trim();
        const src = srcRaw ? this.#wrapDelay(srcRaw, d.sourceDelay) : '';
        const snk = snkRaw ? this.#wrapDelay(snkRaw, d.sinkDelay) : '';

        let rateExpr;
        if (src && snk)       rateExpr = `${src} - (${snk})`;
        else if (src)         rateExpr = src;
        else if (snk)         rateExpr = `-(${snk})`;
        else                  rateExpr = '0';

        return `${name} = ${init}\nd${name}/dt = ${rateExpr}`;
    }

    // ─── Utils ────────────────────────────────────────────────────────────────

    #escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Normalize parameter cell distribution keys to the format the backend expects.
     * Parameter cells use { low, mode, high } for triangular; backend expects { min, max, mode }.
     * Parameter cells use { std }; backend accepts both std and stddev.
     * Parameter cells use { mu, sigma } for lognormal; backend expects { mean, sigma }.
     */
    #normalizeDistribution(dist) {
        const d = { ...dist };
        // Triangular: low→min, high→max
        if (d.type === 'triangular') {
            if (d.low !== undefined) { d.min = d.low; delete d.low; }
            if (d.high !== undefined) { d.max = d.high; delete d.high; }
        }
        // Lognormal: mu→mean
        if (d.type === 'lognormal' && d.mu !== undefined) {
            d.mean = d.mu; delete d.mu;
        }
        // Coerce string values to numbers
        for (const [k, v] of Object.entries(d)) {
            if (k === 'type' || k === 'enabled') continue;
            const num = parseFloat(v);
            if (!isNaN(num)) d[k] = num;
        }
        return d;
    }
}

export const notebookDslCompiler = new NotebookDslCompiler();
