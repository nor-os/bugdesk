/**
 * agent_completions.js — Python autocomplete for the archetype loop editors.
 *
 * One Monaco completion provider is registered globally per language; per
 * editor we attach a context (params + accounts) via a WeakMap so the
 * provider can return archetype-specific suggestions. Triggers:
 *
 *   self.       → declared params · brain · agent_id · account(label)
 *   self.brain. → previously-seen brain keys (from this archetype's
 *                 __init_brain__/observe/execute/adjust source)
 *   ctx.        → ledger · markets · bus · tick · agents
 */

let _registered = false;
const _byModel = new WeakMap();


/** Register the completion provider once per Monaco instance. */
export function registerAgentCompletions(monaco) {
    if (_registered || !monaco) return;
    _registered = true;
    monaco.languages.registerCompletionItemProvider('python', {
        triggerCharacters: ['.'],
        provideCompletionItems(model, position) {
            const ctx = _byModel.get(model);
            if (!ctx) return { suggestions: [] };

            const lineText = model.getValueInRange({
                startLineNumber: position.lineNumber, startColumn: 1,
                endLineNumber:   position.lineNumber, endColumn:   position.column,
            });

            // Word being typed — replace it cleanly on accept.
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber:   position.lineNumber,
                startColumn:     word.startColumn,
                endColumn:       word.endColumn,
            };

            if (/(?:^|[^\w.])self\.brain\.[\w]*$/.test(lineText)) {
                return { suggestions: brainSuggestions(ctx, monaco, range) };
            }
            if (/(?:^|[^\w.])self\.[\w]*$/.test(lineText)) {
                return { suggestions: selfSuggestions(ctx, monaco, range) };
            }
            if (/(?:^|[^\w.])ctx\.[\w]*$/.test(lineText)) {
                return { suggestions: ctxSuggestions(monaco, range) };
            }
            return { suggestions: [] };
        },
    });
}


/** Attach an archetype context to a specific Monaco model. */
export function attachAgentContext(model, ctx) {
    if (!model) return;
    _byModel.set(model, ctx || {});
}


// ── self.<...> ──────────────────────────────────────────────────────────────

function selfSuggestions(ctx, monaco, range) {
    const Kind = monaco.languages.CompletionItemKind;
    const Rules = monaco.languages.CompletionItemInsertTextRule;
    const out = [];

    for (const p of (ctx.params || [])) {
        out.push({
            label: p.name,
            kind: Kind.Property,
            detail: `${p.type ?? 'any'} · default ${formatDefault(p.default)}`,
            documentation: { value: paramDoc(p) },
            insertText: p.name,
            range,
        });
    }
    out.push({
        label: 'brain', kind: Kind.Property,
        detail: 'Brain — writable in __init_brain__ / adjust, read-only elsewhere',
        insertText: 'brain', range,
    });
    out.push({
        label: 'agent_id', kind: Kind.Property,
        detail: 'Unique instance id (str)',
        insertText: 'agent_id', range,
    });
    out.push({
        label: 'account', kind: Kind.Method,
        detail: 'self.account(label) → account id (str)',
        documentation: { value: 'Resolve an account label declared on this archetype to its ledger account id.' },
        insertText: 'account("${1:label}")',
        insertTextRules: Rules.InsertAsSnippet,
        range,
    });
    // Pre-canned variants for each declared account label — saves typing
    // the label and protects against typos.
    for (const acc of (ctx.accounts || [])) {
        out.push({
            label: `account("${acc.label}")`,
            kind: Kind.Method,
            detail: `${acc.type ?? '?'} · ${acc.asset_kind ?? '?'}`,
            insertText: `account("${acc.label}")`,
            range,
        });
    }
    return out;
}

// ── ctx.<...> ───────────────────────────────────────────────────────────────

function ctxSuggestions(monaco, range) {
    const Kind = monaco.languages.CompletionItemKind;
    return [
        { label: 'ledger',  kind: Kind.Property,
          detail: 'LedgerView — balance(account_id), transfer(src,dst,kind,amount,note)',
          insertText: 'ledger', range },
        { label: 'markets', kind: Kind.Property,
          detail: 'dict-like: ctx.markets["goods"].submit(side,price,volume)',
          insertText: 'markets', range },
        { label: 'bus',     kind: Kind.Property,
          detail: 'InfoBus — publish(topic,payload,delay=0) / read(topic,default)',
          insertText: 'bus', range },
        { label: 'tick',    kind: Kind.Property,
          detail: 'Current tick (int)',
          insertText: 'tick', range },
        { label: 'agents',  kind: Kind.Property,
          detail: 'AgentDirectory — agents.by_archetype("banker"), agents["agent_id"]',
          insertText: 'agents', range },
    ];
}

// ── self.brain.<...> ────────────────────────────────────────────────────────

function brainSuggestions(ctx, monaco, range) {
    // Brain shape is dynamic; scrape the archetype's source for
    // `self.brain.<name> = ...` assignments to seed suggestions.
    const Kind = monaco.languages.CompletionItemKind;
    const keys = (ctx.brainKeys instanceof Set ? [...ctx.brainKeys] : []);
    return keys.map((k) => ({
        label: k, kind: Kind.Property,
        detail: 'brain key (declared in this archetype)',
        insertText: k, range,
    }));
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function paramDoc(p) {
    const parts = [];
    if (p.type)             parts.push(`Type: \`${p.type}\``);
    if (p.default != null)  parts.push(`Default: \`${formatDefault(p.default)}\``);
    if (p.min != null || p.max != null) {
        parts.push(`Range: [${p.min ?? '-∞'}, ${p.max ?? '∞'}]`);
    }
    if (Array.isArray(p.choices) && p.choices.length > 0) {
        parts.push(`Choices: ${p.choices.map((c) => `\`${c}\``).join(', ')}`);
    }
    return parts.join('  \n');
}

function formatDefault(v) {
    if (v == null) return 'None';
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
}


/** Scan archetype source for `self.brain.<name> =` and return the set
 *  of names. Used by callers to populate the brain context. */
export function brainKeysFromSources(sources) {
    const found = new Set();
    const re = /self\.brain\.([A-Za-z_][\w]*)\s*=/g;
    for (const src of sources) {
        if (typeof src !== 'string') continue;
        let m;
        while ((m = re.exec(src)) !== null) found.add(m[1]);
    }
    return found;
}
