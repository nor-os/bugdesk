/**
 * ValidationStatus - Bottom bar validation status indicator
 * 
 * Displays the overall validation status (OK, Loop, Invalid) in the bottom bar.
 * Listens to validation events and updates the display accordingly.
 * 
 * This is a port of the validation status from dsl_generator.js to the new architecture.
 */

export class ValidationStatus {
    constructor(options = {}) {
        this.eventBus = options.eventBus || null;
        this.logger = options.logger || console;
        this.dataManager = options.dataManager || null;
        this.nodePlatform = options.nodePlatform || null;
        this.element = null;
        this._status = { ok: true, cycles: [], selfLoops: [], invalidOps: [], invalidOpsDetails: [], invalidExprs: [], invalidExprsDetails: [], accountingErrors: [], accountingErrorsDetails: [] };
        this._subscriptions = [];
        this._popoverCleanup = null;
    }

    /**
     * Mount the status indicator into the bottom bar
     */
    mount() {
        const barLeft = document.querySelector('.global-bottom-bar .bar-left');
        if (!barLeft) {
            this.logger.warn?.('[ValidationStatus] bar-left not found');
            return;
        }

        // Check if already mounted
        let el = document.getElementById('status-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'status-indicator';
            el.className = 'status-indicator ok';
            el.innerHTML = '<span class="material-symbols-outlined">check_circle</span><span>OK</span>';
            window.LatexTooltip?.set(el, 'Model validation status');
            // Insert at the beginning, before sim-status
            barLeft.insertBefore(el, barLeft.firstChild);
        }
        this.element = el;

        // Wire click handler for showing details popup
        el.addEventListener('click', () => this.#handleClick());

        // Subscribe to validation events
        this.#subscribeToEvents();

        // Initial status check
        this.#scheduleValidation();
    }

    /**
     * Unmount and clean up
     */
    unmount() {
        this._subscriptions.forEach(unsub => {
            if (typeof unsub === 'function') unsub();
        });
        this._subscriptions = [];
        
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
    }

    /**
     * Subscribe to relevant events
     */
    #subscribeToEvents() {
        if (!this.eventBus) return;

        // Listen to DSL generator events - this is the primary source of validation status
        const dslHandler = (payload) => {
            if (payload?.status) {
                this.#handleDslStatus(payload.status);
            }
        };
        this.eventBus.on('dsl:generated', dslHandler);
        this._subscriptions.push(() => this.eventBus.off('dsl:generated', dslHandler));

        const dslErrorHandler = (payload) => {
            if (payload?.status) {
                this.#handleDslStatus(payload.status);
            } else if (payload?.error) {
                // DSL generation failed completely
                this.#handleDslStatus({ ok: false, errors: [{ type: 'exception', message: payload.error?.message || 'DSL generation failed' }] });
            }
        };
        this.eventBus.on('dsl:error', dslErrorHandler);
        this._subscriptions.push(() => this.eventBus.off('dsl:error', dslErrorHandler));

        // Also listen to node/workspace events to trigger re-validation via DSL generator
        const events = [
            'node:created',
            'node:removed',
            'node:updated',
            'connection:added',
            'connection:removed',
            'flow:updated',
            'godley:flow:upsert',
            'godley:flow:delete',
            'workspace:imported',
            'WorkspaceLoader:complete',
            'tabs:namespace:selected',
            'data:namespaces:added',
            'data:namespaces:removed',
            'data:stocks:updated',
            'initial-condition:updated',
            'validation:refresh-request',
        ];

        events.forEach(eventName => {
            const handler = () => this.#scheduleValidation();
            this.eventBus.on(eventName, handler);
            this._subscriptions.push(() => this.eventBus.off(eventName, handler));
        });
    }

    /**
     * Handle status from DSL generator
     */
    #handleDslStatus(dslStatus) {
        // Convert DSL generator status format to ValidationStatus format
        const status = {
            ok: dslStatus.ok !== false,
            cycles: [],
            selfLoops: [],
            invalidOps: [],
            invalidOpsDetails: [],
            invalidExprs: [],
            invalidExprsDetails: [],
            accountingErrors: [],
            accountingErrorsDetails: [],
        };

        // Parse errors from DSL generator
        const errors = dslStatus.errors || [];
        errors.forEach(err => {
            if (err.type === 'cycle') {
                // Parse cycle message: "Circular dependency detected: X, Y, Z"
                const match = err.message?.match(/Circular dependency detected: (.+)/);
                if (match) {
                    const cycleVars = match[1].split(',').map(s => s.trim());
                    cycleVars.forEach(v => status.cycles.push(v));
                }
            } else if (err.type === 'missing-input' || err.type === 'invalid-operation') {
                status.invalidOps.push(err.varName || err.nodeId || 'Unknown');
                status.invalidOpsDetails.push({
                    var: err.varName || err.nodeId || 'Unknown',
                    nodeId: err.nodeId || '',
                    namespaceId: err.namespaceId || '',
                    reasons: [err.message || 'Invalid operation']
                });
            } else if (err.type === 'invalid-expression' || err.type === 'expression') {
                status.invalidExprs.push({
                    var: err.varName || err.nodeId || 'Unknown',
                    nodeId: err.nodeId || '',
                    namespaceId: err.namespaceId || '',
                    reasons: [err.message || 'Invalid expression']
                });
                status.invalidExprsDetails.push({
                    var: err.varName || err.nodeId || 'Unknown',
                    nodeId: err.nodeId || '',
                    namespaceId: err.namespaceId || '',
                    reasons: [err.message || 'Invalid expression']
                });
            } else if (err.type === 'undefined-reference') {
                status.invalidExprs.push({
                    var: err.varName || err.nodeId || 'Unknown',
                    nodeId: err.nodeId || '',
                    namespaceId: err.namespaceId || '',
                    reasons: [err.message || 'References undefined variable']
                });
                status.invalidExprsDetails.push({
                    var: err.varName || err.nodeId || 'Unknown',
                    nodeId: err.nodeId || '',
                    namespaceId: err.namespaceId || '',
                    reasons: [err.message || 'References undefined variable']
                });
            } else if (err.type === 'exception') {
                // General exception during DSL generation
                status.invalidExprs.push({
                    var: 'DSL Generator',
                    reasons: [err.message || 'DSL generation failed']
                });
            } else if (err.type === 'accounting' || err.type === 'godley') {
                // Accounting errors from Godley tables
                status.accountingErrors.push({
                    var: err.varName || err.tableId || 'Unknown',
                    tableId: err.tableId || '',
                    reasons: [err.message || 'Accounting error']
                });
            }
        });

        // Also check accounting errors from Godley tables (not emitted by DSL generator)
        this.#detectAccountingErrors(status);

        // Also check node-level validation errors (expression validation, unknown names, etc.)
        this.#detectInvalidOperations(status);

        // Update overall ok status
        status.ok = status.cycles.length === 0 &&
                    status.selfLoops.length === 0 &&
                    status.invalidOps.length === 0 &&
                    status.invalidExprs.length === 0 &&
                    status.accountingErrors.length === 0;

        this._status = status;
        this.#updateDisplay(status);

        // Emit validation status event for other components
        if (this.eventBus) {
            this.eventBus.emit('validation:status-updated', status);
        }
    }

    #validationTimeout = null;

    /**
     * Schedule a validation update (debounced)
     */
    #scheduleValidation() {
        if (this.#validationTimeout) {
            clearTimeout(this.#validationTimeout);
        }
        this.#validationTimeout = setTimeout(() => {
            this.#runValidation();
        }, 100);
    }

    /**
     * Run validation and update status
     */
    #runValidation() {
        // Try to trigger DSL generation which will emit dsl:generated with status
        // This is the primary validation mechanism
        if (window.dslGenerator?.generate) {
            try {
                window.dslGenerator.generate({ scope: 'project' });
                // The dsl:generated event handler will update the status
                return;
            } catch (err) {
                this.logger.warn?.('[ValidationStatus] DSL generation failed:', err);
            }
        }

        // Fallback: compute status from DOM if DSL generator not available
        const status = this.#computeValidationStatus();
        this._status = status;
        this.#updateDisplay(status);

        // Emit validation status event for other components
        if (this.eventBus) {
            this.eventBus.emit('validation:status-updated', status);
        }
    }

    /**
     * Compute the overall validation status
     */
    #computeValidationStatus() {
        const status = {
            ok: true,
            cycles: [],
            selfLoops: [],
            invalidOps: [],
            invalidOpsDetails: [],
            invalidExprs: [],
            invalidExprsDetails: [],
            accountingErrors: [],
            accountingErrorsDetails: [],
        };

        try {
            // Check for cycles and self-loops in the node graph
            this.#detectCycles(status);

            // Check for invalid operations (nodes with validation errors)
            this.#detectInvalidOperations(status);

            // Check accounting validation if AccountingValidator is available
            this.#detectAccountingErrors(status);

            // Determine overall status
            status.ok = (
                status.cycles.length === 0 &&
                status.selfLoops.length === 0 &&
                status.invalidOps.length === 0 &&
                status.invalidExprs.length === 0 &&
                status.invalidOpsDetails.length === 0 &&
                status.invalidExprsDetails.length === 0 &&
                status.accountingErrors.length === 0 &&
                status.accountingErrorsDetails.length === 0
            );
        } catch (err) {
            this.logger.error?.('[ValidationStatus] Validation failed:', err);
        }

        return status;
    }

    /**
     * Detect cycles in the node graph
     */
    #detectCycles(status) {
        // Get all nodes and their connections
        const nodes = document.querySelectorAll('.node:not(.template)');
        const connections = document.querySelectorAll('#canvas line.connection, #canvas path.connection');
        
        // Build adjacency list
        const adjacency = new Map();
        nodes.forEach(node => {
            adjacency.set(node.id, new Set());
        });

        connections.forEach(conn => {
            const fromId = conn.dataset?.from || conn.getAttribute('data-from');
            const toId = conn.dataset?.to || conn.getAttribute('data-to');
            if (fromId && toId && adjacency.has(fromId)) {
                adjacency.get(fromId).add(toId);
            }
        });

        // Detect self-loops
        adjacency.forEach((targets, nodeId) => {
            if (targets.has(nodeId)) {
                const node = document.getElementById(nodeId);
                const name = this.#getNodeName(node);
                status.selfLoops.push(name || nodeId);
            }
        });

        // Detect cycles using DFS
        const visited = new Set();
        const recStack = new Set();
        const cycleNodes = new Set();

        const dfs = (nodeId, path) => {
            if (recStack.has(nodeId)) {
                // Found a cycle - add all nodes in the current path from this node
                const cycleStart = path.indexOf(nodeId);
                if (cycleStart >= 0) {
                    for (let i = cycleStart; i < path.length; i++) {
                        cycleNodes.add(path[i]);
                    }
                }
                return true;
            }
            if (visited.has(nodeId)) return false;

            visited.add(nodeId);
            recStack.add(nodeId);
            path.push(nodeId);

            const neighbors = adjacency.get(nodeId) || new Set();
            for (const neighbor of neighbors) {
                if (neighbor !== nodeId) { // Skip self-loops, handled separately
                    dfs(neighbor, path);
                }
            }

            path.pop();
            recStack.delete(nodeId);
            return false;
        };

        adjacency.forEach((_, nodeId) => {
            if (!visited.has(nodeId)) {
                dfs(nodeId, []);
            }
        });

        cycleNodes.forEach(nodeId => {
            const node = document.getElementById(nodeId);
            const name = this.#getNodeName(node);
            if (name && !status.selfLoops.includes(name)) {
                status.cycles.push(name);
            }
        });
    }

    /**
     * Detect invalid operations (nodes with validation errors from snapshot state).
     *
     * Forwards all node-level validation errors to the global status without
     * filtering.  Node-level scoped validation is authoritative — if it reports
     * an unknown name, it means the variable is not connected to this node.
     */
    #detectInvalidOperations(status) {
        const platform = this.nodePlatform || window.dslGenerator?.nodePlatform;
        if (!platform) return;

        const seenNodeIds = new Set(
            status.invalidExprs.map(e => e.nodeId).filter(Boolean)
        );

        const snapshots = platform.listNodes();

        for (const snapshot of snapshots) {
            const nodeId = snapshot.id;
            if (seenNodeIds.has(nodeId)) continue;

            const validation = snapshot.state?.validation;
            if (!validation || validation.isValid !== false) continue;

            const errors = [];

            if (Array.isArray(validation.errors)) {
                for (const err of validation.errors) {
                    errors.push(err);
                }
            }

            if (Array.isArray(validation.unknown) && validation.unknown.length) {
                errors.push(`Unknown names: ${validation.unknown.join(', ')}`);
            }

            if (!errors.length) continue;

            const name = snapshot.config?.displayName
                || snapshot.state?.displayName
                || snapshot.config?.variableName
                || nodeId;

            status.invalidExprs.push({
                var: name,
                nodeId,
                namespaceId: snapshot.namespaceId,
                reasons: errors,
            });
            status.invalidExprsDetails.push({
                var: name,
                nodeId,
                namespaceId: snapshot.namespaceId,
                reasons: errors,
            });
        }
    }

    /**
     * Detect accounting errors from Godley tables
     * Works with or without AccountingValidator for advanced equation checking
     */
    #detectAccountingErrors(status) {
        try {
            this.#detectGodleyAccounting(status);
            status.accountingErrorsDetails = (status.accountingErrors || []).map(err => ({
                var: err.var,
                message: err.message,
                sector: err.sector,
                nodeId: err.nodeId,
                namespaceId: err.namespaceId || err.tabId || '',
                namespaceName: err.namespaceName || (err.namespaceId ? this.#resolveTabTitle(err.namespaceId) : ''),
                tabId: err.namespaceId || err.tabId || '',
                accounts: err.accounts,
                reasons: err.reasons || (err.message ? [err.message] : []),
            }));
        } catch (err) {
            this.logger.warn?.('[ValidationStatus] Accounting validation error:', err);
        }
    }

    #detectGodleyAccounting(status) {
        const dm = this.dataManager;
        if (!dm || typeof dm.listFlows !== 'function' || typeof dm.listStocks !== 'function') return;

        const resolveNamespaceName = (nsId) => this.#resolveTabTitle(nsId) || nsId || 'Unknown namespace';

        // Build account shapes per (namespace, sector)
        const stocks = dm.listStocks();
        const shapes = new Map(); // key => { accountShape, stockIdToComposite, initialValues }

        const normalizeType = (t) => {
            const s = String(t || '').toLowerCase();
            if (s.startsWith('asset')) return 'Assets';
            if (s.startsWith('liab')) return 'Liabilities';
            if (s.startsWith('equity') || s.startsWith('equ')) return 'Equity';
            return null;
        };

        const getKey = (ns, sector) => `${ns || ''}::${sector || ''}`;

        // Namespace-wide stockId → composite map for cross-sector flows
        const nsWideStockMaps = new Map(); // namespaceId → Map<stockId, composite>

        stocks.forEach((stock) => {
            const namespaceId = stock?.namespaceId;
            const sector = stock?.sectorId || stock?.sector || '';
            const name = stock?.accountName || stock?.name;
            const type = normalizeType(stock?.accountType || stock?.type);
            if (!namespaceId || !type || !name) return;

            const key = getKey(namespaceId, sector);
            if (!shapes.has(key)) {
                shapes.set(key, {
                    accountShape: { Assets: [], Liabilities: [], Equity: [] },
                    stockIdToComposite: new Map(),
                    initialValues: { Assets: 0, Liabilities: 0, Equity: 0 },
                });
            }
            const bucket = shapes.get(key);
            bucket.accountShape[type].push(name);

            // Accumulate initial values per account type for balance check
            const iv = Number(stock.initialValue ?? stock.initial ?? 0);
            if (Number.isFinite(iv)) {
                bucket.initialValues[type] += iv;
            }

            if (stock.id) {
                bucket.stockIdToComposite.set(stock.id, `${type}::${name}`);

                // Also add to namespace-wide map
                if (!nsWideStockMaps.has(namespaceId)) {
                    nsWideStockMaps.set(namespaceId, new Map());
                }
                nsWideStockMaps.get(namespaceId).set(stock.id, `${type}::${name}`);
            }
        });

        if (shapes.size === 0) return;

        // --- Validate initial condition balance per (namespace, sector) ---
        this.#validateInitialConditionBalance(status, shapes, resolveNamespaceName, getKey);

        // --- Validate flow equations ---
        const flows = dm.listFlows((flow) => flow?.metadata?.source === 'godley-table');
        if (!flows.length) return;

        const formatExpr = (expr, coefficient) => {
            if (!expr) return '';
            const coeff = Number.isFinite(Number(coefficient)) ? Number(coefficient) : 1;
            return coeff === 1 ? expr : `${coeff} * (${expr})`;
        };

        flows.forEach((flow) => {
            const namespaceId = flow?.namespaceId;
            const namespaceName = resolveNamespaceName(namespaceId);
            const sector = flow?.metadata?.sector || flow?.sector || '';
            const key = getKey(namespaceId, sector);
            const shape = shapes.get(key);

            if (!shape) {
                // Cross-sector flow (no sector): validate legs against namespace-wide stock map
                if (!sector) {
                    const nsMap = nsWideStockMaps.get(namespaceId);
                    if (!nsMap || nsMap.size === 0) {
                        status.accountingErrors.push({
                            var: flow?.name || flow?.id,
                            message: 'No stocks found in namespace',
                            sector,
                            nodeId: flow?.id,
                            namespaceId,
                            namespaceName,
                        });
                        return;
                    }

                    const legs = Array.isArray(flow?.legs) ? flow.legs : [];
                    let hasUnmapped = false;
                    for (const leg of legs) {
                        if (!leg?.stockId) continue;
                        if (!nsMap.has(leg.stockId)) {
                            hasUnmapped = true;
                            break;
                        }
                    }

                    if (hasUnmapped) {
                        status.accountingErrors.push({
                            var: flow?.name || flow?.id,
                            message: 'Unknown account mapping',
                            sector,
                            nodeId: flow?.id,
                            namespaceId,
                            namespaceName,
                        });
                    }
                    // Cross-sector flows skip per-sector A-L-E=0 equation check
                    return;
                }

                status.accountingErrors.push({
                    var: flow?.name || flow?.id,
                    message: 'No accounts for sector',
                    sector,
                    nodeId: flow?.id,
                    namespaceId,
                    namespaceName,
                });
                return;
            }

            const { accountShape, stockIdToComposite } = shape;
            const hasBalanceSides = (accountShape.Liabilities.length + accountShape.Equity.length) > 0;
            if (!hasBalanceSides) {
                status.accountingErrors.push({
                    var: flow?.name || flow?.id,
                    message: 'Add Liabilities/Equity accounts',
                    sector,
                    nodeId: flow?.id,
                    namespaceId,
                    namespaceName,
                    accounts: accountShape,
                });
                return;
            }

            const entries = {};
            let hasUnmapped = false;
            const nsMap = nsWideStockMaps.get(namespaceId);
            (Array.isArray(flow?.legs) ? flow.legs : []).forEach((leg) => {
                const expr = (leg?.expression || '').trim();
                if (!expr || !leg?.stockId) return;
                const composite = stockIdToComposite.get(leg.stockId);
                if (!composite) {
                    // Leg may belong to a different sector (cross-sector flow).
                    // Check namespace-wide map; only flag as unmapped if truly unknown.
                    if (!nsMap?.has(leg.stockId)) {
                        hasUnmapped = true;
                    }
                    return;
                }
                entries[composite] = formatExpr(expr, leg?.coefficient);
            });

            if (hasUnmapped) {
                status.accountingErrors.push({
                    var: flow?.name || flow?.id,
                    message: 'Unknown account mapping',
                    sector,
                    nodeId: flow?.id,
                    namespaceId,
                    namespaceName,
                    accounts: accountShape,
                });
                return;
            }

            // Cross-sector flow (all legs in other sectors) or genuinely empty — skip equation check
            if (Object.keys(entries).length === 0) return;

            // Use AccountingValidator if available for full equation checking
            if (window.AccountingValidator?.validateFlowRow) {
                try {
                    const result = window.AccountingValidator.validateFlowRow(accountShape, entries);
                    const isValid = !!(result && result.valid && !result.complex);
                    if (!isValid) {
                        status.accountingErrors.push({
                            var: flow?.name || flow?.id,
                            message: result?.message || 'Assets ≠ Liabilities + Equity',
                            sector,
                            nodeId: flow?.id,
                            namespaceId,
                            namespaceName,
                            accounts: accountShape,
                            reasons: result?.message ? [result.message] : ['Assets ≠ Liabilities + Equity']
                        });
                    }
                } catch (err) {
                    this.logger?.warn?.('[ValidationStatus] AccountingValidator.validateFlowRow failed:', err);
                }
            } else {
                // Fallback: check if all account types have entries (structural check)
                const assetsEntries = Object.keys(entries).filter(k => k.startsWith('Assets::'));
                const liabEquityEntries = Object.keys(entries).filter(k => k.startsWith('Liabilities::') || k.startsWith('Equity::'));
                if (assetsEntries.length === 0 || liabEquityEntries.length === 0) {
                    status.accountingErrors.push({
                        var: flow?.name || flow?.id,
                        message: 'Must have entries on both sides (Assets and Liabilities/Equity)',
                        sector,
                        nodeId: flow?.id,
                        namespaceId,
                        namespaceName,
                        accounts: accountShape,
                        reasons: ['Must have entries on both sides of the balance sheet']
                    });
                }
            }
        });
    }

    /**
     * Validate that initial conditions balance per (namespace, sector).
     * Assets = Liabilities + Equity within a tolerance of 0.0001.
     */
    #validateInitialConditionBalance(status, shapes, resolveNamespaceName, getKey) {
        const TOLERANCE = 0.0001;

        for (const [key, bucket] of shapes) {
            const { accountShape, initialValues } = bucket;
            const hasLiabOrEquity = (accountShape.Liabilities.length + accountShape.Equity.length) > 0;
            if (!hasLiabOrEquity) continue;

            const sumA = initialValues.Assets;
            const sumLE = initialValues.Liabilities + initialValues.Equity;
            if (Math.abs(sumA - sumLE) < TOLERANCE) continue;

            // Extract namespace and sector from key "nsId::sector"
            const sepIdx = key.indexOf('::');
            const namespaceId = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
            const sector = sepIdx >= 0 ? key.slice(sepIdx + 2) : '';
            const namespaceName = resolveNamespaceName(namespaceId);

            const diff = sumA - sumLE;
            const sign = diff > 0 ? '+' : '';
            const message = `Initial conditions unbalanced: Assets (${sumA}) ≠ Liabilities + Equity (${sumLE}), diff = ${sign}${diff.toFixed(4)}`;

            status.accountingErrors.push({
                var: sector ? `${sector} (initial)` : '(initial)',
                message,
                sector,
                namespaceId,
                namespaceName,
                accounts: accountShape,
                reasons: [`Initial conditions: Assets ≠ Liabilities + Equity (off by ${Math.abs(diff).toFixed(4)})`],
            });
        }
    }

    /**
     * Get the display name of a node
     */
    #getNodeName(node) {
        if (!node) return null;
        
        // Try instance method first
        if (node._instance?.getDisplayName) {
            return node._instance.getDisplayName();
        }
        
        // Try data attributes
        return node.dataset?.name ||
               node.dataset?.variableName ||
               node.dataset?.displayName ||
               node.querySelector('.node-name, .display-name')?.textContent ||
               null;
    }

    /**
     * Update the status indicator display
     */
    #updateDisplay(status) {
        if (!this.element) return;

        const { cycles, selfLoops, invalidOps, invalidExprs, accountingErrors, accountingErrorsDetails, invalidOpsDetails, invalidExprsDetails } = status;
        const hasLoops = cycles.length > 0 || selfLoops.length > 0;
        const hasInvalid = (invalidOps.length > 0 || invalidExprs.length > 0 || (invalidOpsDetails?.length > 0) || (invalidExprsDetails?.length > 0));
        const hasAccounting = accountingErrors.length > 0 || (accountingErrorsDetails?.length > 0);

        this.element.classList.remove('ok', 'loop', 'invalid');

        if (hasLoops) {
            this.element.classList.add('loop');
            this.element.innerHTML = '<span class="material-symbols-outlined">sync_problem</span><span>Loop</span>';
            const detail = [...new Set([...cycles, ...selfLoops])];
            window.LatexTooltip?.set(this.element, detail.length ? `Loop detected in: ${detail.join(', ')}` : 'Loop detected');
        } else if (hasInvalid || hasAccounting) {
            this.element.classList.add('invalid');
            this.element.innerHTML = '<span class="material-symbols-outlined">error</span><span>Invalid</span>';
            
            if (invalidExprs.length > 0) {
                const exprList = [...new Set(invalidExprs.map(e => e.var))];
                window.LatexTooltip?.set(this.element, `Invalid expressions: ${exprList.join(', ')}`);
            } else if (hasAccounting) {
                const acctDetails = (accountingErrorsDetails && accountingErrorsDetails.length)
                    ? accountingErrorsDetails
                    : accountingErrors;
                const grouped = new Map();
                acctDetails.forEach((err) => {
                    const ns = err.namespaceName || err.namespaceId || 'Unknown namespace';
                    const sector = err.sector || '';
                    const key = `${ns}::${sector}`;
                    if (!grouped.has(key)) {
                        grouped.set(key, { ns, sector, flows: [] });
                    }
                    grouped.get(key).flows.push(err.var || 'Flow');
                });
                const tooltip = grouped.size
                    ? Array.from(grouped.values()).map(g => `${g.ns}${g.sector ? ` / ${g.sector}` : ''}: ${g.flows.join(', ')}`).join(' | ')
                    : 'Accounting errors detected (Godley table)';
                window.LatexTooltip?.set(this.element, `Accounting errors: ${tooltip}`);
            } else if (invalidOps.length > 0) {
                window.LatexTooltip?.set(this.element, `Invalid nodes: ${invalidOps.join(', ')}`);
            }
        } else {
            this.element.classList.add('ok');
            this.element.innerHTML = '<span class="material-symbols-outlined">check_circle</span><span>OK</span>';
            window.LatexTooltip?.set(this.element, 'Model validation OK');
        }

        // Dispatch DOM event for legacy compatibility
        try {
            window.dispatchEvent(new CustomEvent('dsl:status', { detail: status }));
        } catch (_) {}
    }

    /**
     * Handle click on status indicator - show details popup
     */
    #handleClick() {
        if (this._status.ok) return;
        const payload = this.#normalizedPayloadForPopup();

        // Try legacy popup first if available
        if (window.uiManager?.showStatusDetails) {
            try {
                window.uiManager.showStatusDetails(payload, this.element, { placement: 'top' });
                return;
            } catch (err) {
                this.logger.warn?.('[ValidationStatus] showStatusDetails failed', err);
            }
        }

        // Render inline legacy-style popup as a fallback
        this.#renderStatusPopover(payload);
    }

    /**
     * Build a normalized payload for popover consumption
     */
    #normalizedPayloadForPopup() {
        return {
            ...this._status,
            accountingErrorsDetails: (this._status.accountingErrorsDetails && this._status.accountingErrorsDetails.length)
                ? this._status.accountingErrorsDetails
                : (this._status.accountingErrors || []).map(err => ({
                    var: err.var,
                    message: err.message,
                    sector: err.sector,
                    nodeId: err.nodeId,
                    reasons: err.message ? [err.message] : []
                })),
        };
    }

    /**
     * Inline legacy-style popover (used when uiManager.showStatusDetails is unavailable)
     */
    #renderStatusPopover(payload) {
        // Clean existing popover
        if (typeof this._popoverCleanup === 'function') {
            try { this._popoverCleanup(); } catch (_) {}
            this._popoverCleanup = null;
        }

        const entries = this.#normalizeEntries(payload || {});
        if (!entries.length) {
            this.logger.info?.('[ValidationStatus] No issues to display');
            return;
        }

        const byTab = new Map();
        entries.forEach((entry) => {
            const key = entry.tabId || 'untitled';
            if (!byTab.has(key)) byTab.set(key, []);
            byTab.get(key).push(entry);
        });

        const pop = document.createElement('div');
        pop.className = 'tab-close-popover status-popup status-details-popover';
        pop.style.position = 'fixed';
        pop.style.zIndex = '9999';

        const groupsHtml = Array.from(byTab.entries()).map(([tabId, items]) => {
            const tabName = this.#resolveTabTitle(tabId);
            const list = items.map(e => {
                const icon = e.type === 'op' ? 'tune' : (e.type === 'expr' ? 'functions' : (e.type === 'acct' ? 'account_balance' : 'sync_problem'));
                const titleText = e.reasons && e.reasons.length ? e.reasons.join(', ') : 'Click to locate';
                const msgText = e.reasons && e.reasons.length ? e.reasons[0] : 'Click to locate';
                const tabAttr = (tabId && tabId !== 'untitled') ? ` data-tabid="${tabId}"` : '';
                const nidAttr = e.nodeId ? ` data-nodeid="${e.nodeId}"` : '';
                return `<li class="issue-item ${e.type||''} has-tooltip" data-var="${e.var}"${tabAttr}${nidAttr} data-tooltip="${titleText}">`+
                       `<div class="status-row nested">`+
                         `<div class="node-cell"><span class="material-symbols-outlined">account_tree</span><span class="node-name">${e.var}</span></div>`+
                         `<div class="msg-cell"><span class="material-symbols-outlined">${icon}</span><span class="text">${msgText}</span></div>`+
                       `</div>`+
                       `</li>`;
            }).join('');
            return `<div class="tab-group" data-tabid="${tabId}">`+
                   `<div class="tab-group-header"><span class="material-symbols-outlined">tab</span><span class="tab-name">${tabName}</span><span class="pill-count">${items.length}</span></div>`+
                   `<ul class="issue-list">${list}</ul>`+
                   `</div>`;
        }).join('');

        pop.innerHTML = `
            <div class="details-header">
                <span class="title">Status details</span>
                <button class="close-btn has-tooltip" data-tooltip="Close">✕</button>
            </div>
            <div class="details-body">${groupsHtml || '<div class="empty">No issues</div>'}</div>
        `;

        const placement = 'top';
        pop.classList.add(`placement-${placement}`);
        document.body.appendChild(pop);
        this.#positionPopover(pop, this.element, { placement });

        const cleanup = () => {
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onWin, true);
            try { pop.remove(); } catch (_) {}
            this._popoverCleanup = null;
        };
        this._popoverCleanup = cleanup;

        const onDocDown = (ev) => { if (!pop.contains(ev.target)) cleanup(); };
        const onKey = (ev) => { if (ev.key === 'Escape') cleanup(); };
        const onWin = () => cleanup();
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onWin, true);

        pop.querySelector('.close-btn')?.addEventListener('click', cleanup);
        pop.querySelectorAll('.tab-group-header').forEach(h => {
            h.addEventListener('click', () => {
                const tabId = h.parentElement?.getAttribute('data-tabid') || '';
                this.#activateTab(tabId);
            });
        });
        pop.querySelectorAll('li.issue-item').forEach(li => {
            li.addEventListener('click', () => {
                const tabId = li.getAttribute('data-tabid') || '';
                const nodeId = li.getAttribute('data-nodeid') || '';
                const varName = li.getAttribute('data-var') || '';
                cleanup();
                if (nodeId) {
                    this.#focusNode(nodeId, varName, tabId);
                } else {
                    this.#activateTab(tabId);
                    this.#focusNode(null, varName, tabId);
                }
            });
            li.style.cursor = 'pointer';
        });
    }

    #normalizeEntries(payload) {
        const out = [];
        const push = (e, type) => {
            if (!e) return;
            if (typeof e === 'string') e = { var: e };
            const tabId = e.tabId || e.namespaceId || this.#resolveTabId(e.nodeId, e.var);
            out.push({
                var: String(e.var || ''),
                reasons: Array.isArray(e.reasons) ? e.reasons : (Array.isArray(e.errors) ? e.errors : (e.message ? [e.message] : [])),
                tabId,
                nodeId: e.nodeId || '',
                type,
            });
        };

        (payload.invalidOpsDetails || payload.invalidOps || []).forEach(e => push(e, 'op'));
        (payload.invalidExprsDetails || payload.invalidExprs || []).forEach(e => push(e, 'expr'));
        (payload.accountingErrorsDetails || []).forEach(e => push(e, 'acct'));

        const loopItems = [];
        (payload.cycles || []).forEach(item => { loopItems.push(item); });
        (payload.selfLoops || []).forEach(item => { loopItems.push(item); });
        loopItems.forEach(item => push(item, 'loop'));

        return out;
    }

    #resolveTabId(nodeId, varName) {
        try {
            if (nodeId) {
                const nodeEl = document.getElementById(nodeId);
                const tab = nodeEl?.closest?.('.tab-content');
                if (tab?.id) return tab.id;
            }
            if (varName) {
                const node = Array.from(document.querySelectorAll('.workspace .node')).find(n => {
                    const nm = this.#getNodeName(n);
                    return nm === varName;
                });
                const tab = node?.closest?.('.tab-content');
                if (tab?.id) return tab.id;
            }
        } catch (_) {}
        const active = document.querySelector('.tab-content.active');
        return active?.id || '';
    }

    #resolveTabTitle(tabId) {
        if (!tabId || tabId === 'untitled') return 'Untitled';
        try {
            const tab = document.querySelector(`.left-top .tab[data-tab="${tabId}"]`);
            return tab?.querySelector('.tab-title')?.textContent?.trim() || tabId;
        } catch (_) { return tabId; }
    }

    #activateTab(tabId) {
        if (!tabId) return;
        try {
            const tab = document.querySelector(`.left-top .tab[data-tab="${tabId}"]`);
            if (tab && window.uiManager?.activateTab) {
                window.uiManager.activateTab(tab);
            } else if (tab) {
                tab.click?.();
            }
        } catch (_) {}
    }

    #focusNode(nodeId, varName, namespaceId) {
        // Resolve nodeId from varName if not provided
        if (!nodeId && varName) {
            const platform = this.nodePlatform || window.dslGenerator?.nodePlatform;
            if (platform) {
                const match = platform.listNodes().find(s =>
                    (s.config?.displayName || s.state?.displayName || s.config?.variableName) === varName
                );
                if (match) nodeId = match.nodeId;
            }
        }
        if (!nodeId) return;

        // Use the standard selection event which handles mode switch, tab switch,
        // node selection (visual highlight), and scroll-into-view
        if (this.eventBus) {
            this.eventBus.emit('node:select:request', {
                nodeId,
                namespaceId: namespaceId || undefined,
                focus: true,
                openPanel: true,
            });
        }
    }

    #positionPopover(pop, anchorEl, options = {}) {
        const gap = 10;
        const placement = options.placement === 'bottom' ? 'bottom' : 'top';
        const anchorRect = (anchorEl && anchorEl.getBoundingClientRect()) || { top: 0, left: 0, width: 0, height: 0 };

        const popRect = pop.getBoundingClientRect();
        let top = placement === 'bottom'
            ? (anchorRect.top + anchorRect.height + gap)
            : (anchorRect.top - popRect.height - gap);
        let left = anchorRect.left + (anchorRect.width / 2) - (popRect.width / 2);

        // Clamp to viewport
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        left = clamp(left, 8, Math.max(8, vw - popRect.width - 8));
        top = clamp(top, 8, Math.max(8, vh - popRect.height - 8));

        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(top)}px`;
    }

    /**
     * Get current validation status
     */
    getStatus() {
        return { ...this._status };
    }

    /**
     * Force a validation update
     */
    refresh() {
        this.#runValidation();
    }
}

// Export singleton for convenience
export const validationStatus = new ValidationStatus();
