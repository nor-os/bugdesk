/**
 * python_query_helpers.js — shared Python helper catalogue + caret
 * parser used by both the KPI expression editor (kpi_tab.js) and the
 * bottom-panel Query terminal (bottom_panel.js).
 *
 * The catalogue mirrors `_build_safe_globals` in `ecoagent/sim/kpis.py`
 * — the same FP / aggregation vocabulary the KPI engine and
 * `shell_eval` both speak. Keeping a single source on the JS side
 * means autocomplete + the scope panel agree between the two
 * surfaces.
 */

export const PYTHON_HELPERS = [
    // ---- legacy free functions kept callable for back-compat. ----
    // Every entry below has a direct proxy/entity equivalent and is
    // demoted in autocomplete via the `legacy: true` tag.
    {
        name: 'stock',
        signature: "stock(kind, type='Assets', country=...)",
        snippet: "stock('${1:deposits}')",
        detail: '[legacy] Use world.stock(kind) or countries[id].stock(kind).',
        legacy: true,
        argHints: { 0: 'asset_kind', 1: 'enum:Assets|Liabilities|Equity' },
    },
    {
        name: 'bus',
        signature: 'bus(topic, default=0)',
        snippet: "bus('${1:rates.policy}', ${2:0})",
        detail: 'Read a prior-tick value off the InfoBus (proxy form also OK).',
        argHints: { 0: 'bus_topic' },
    },
    {
        name: 'market_price',
        signature: 'market_price(market_id, default=0)',
        snippet: "market_price('${1:goods}', ${2:0})",
        detail: '[legacy] Use markets[id].price.',
        legacy: true,
        argHints: { 0: 'market' },
    },
    {
        name: 'n_agents',
        signature: 'n_agents(agent=None, country=...)',
        snippet: "n_agents('${1:worker}')",
        detail: 'Count of agent instances for an agent. Use agents.where(agent=…).count for richer filters.',
        argHints: { 0: 'agent' },
    },
    {
        name: 'agent_balance',
        signature: 'agent_balance(instance_id, account_label, default=0)',
        snippet: "agent_balance('${1:banker-0}', '${2:Reserves}', ${3:0})",
        detail: 'Balance for one specific instance. Pass the runtime id (`<agent>-<n>`).',
        argHints: { 0: 'instance_id', 1: 'account_label' },
    },
    {
        name: 'agent_attr',
        signature: 'agent_attr(instance_id, attr, default=0)',
        snippet: "agent_attr('${1:central_bank-0}', '${2:policy_rate}', ${3:0})",
        detail: 'Attribute value for one specific instance.',
        argHints: { 0: 'instance_id' },
    },
    {
        name: 'archetype_stock',
        signature: "archetype_stock(agent, kind, type='Assets', country=...)",
        snippet: "archetype_stock('${1:household}', '${2:deposits}')",
        detail: '[legacy alias] Use agent_stock.',
        legacy: true,
        argHints: { 0: 'agent', 1: 'asset_kind', 2: 'enum:Assets|Liabilities|Equity' },
    },
    // ---- canonical per-agent reductions ----
    // The `agent_*` form is preferred. `archetype_*` aliases work for
    // back-compat with KPI files saved before the rename.
    {
        name: 'agent_balance_sum',
        signature: 'agent_balance_sum(agent, account, country=...)',
        snippet: "agent_balance_sum('${1:household}', '${2:Deposits}')",
        detail: 'Sum of account balances across every instance of <agent>.',
        argHints: { 0: 'agent', 1: 'account_label' },
    },
    {
        name: 'agent_balance_mean',
        signature: 'agent_balance_mean(agent, account, country=...)',
        snippet: "agent_balance_mean('${1:household}', '${2:Deposits}')",
        detail: 'Mean of account balances across every instance of <agent>.',
        argHints: { 0: 'agent', 1: 'account_label' },
    },
    {
        name: 'agent_attr_sum',
        signature: 'agent_attr_sum(agent, attr, country=...)',
        snippet: "agent_attr_sum('${1:household}', '${2:c_intent}')",
        detail: 'Sum of an attribute value across every instance of <agent>.',
        argHints: { 0: 'agent' },
    },
    {
        name: 'agent_attr_mean',
        signature: 'agent_attr_mean(agent, attr, country=...)',
        snippet: "agent_attr_mean('${1:household}', '${2:c_intent}')",
        detail: 'Mean of an attribute value across every instance of <agent>.',
        argHints: { 0: 'agent' },
    },
    {
        name: 'agent_stock',
        signature: "agent_stock(agent, kind, type='Assets', country=...)",
        snippet: "agent_stock('${1:household}', '${2:deposits}')",
        detail: 'Sum of ledger stocks across every instance of <agent>.',
        argHints: { 0: 'agent', 1: 'asset_kind', 2: 'enum:Assets|Liabilities|Equity' },
    },
    // ---- legacy archetype_* aliases (pre-rename KPI back-compat) ----
    {
        name: 'archetype_balance_sum',
        signature: 'archetype_balance_sum(agent, account, country=...)',
        snippet: "archetype_balance_sum('${1:household}', '${2:Deposits}')",
        detail: '[legacy alias] Use agent_balance_sum.',
        legacy: true,
        argHints: { 0: 'agent', 1: 'account_label' },
    },
    {
        name: 'archetype_balance_mean',
        signature: 'archetype_balance_mean(agent, account, country=...)',
        snippet: "archetype_balance_mean('${1:household}', '${2:Deposits}')",
        detail: '[legacy alias] Use agent_balance_mean.',
        legacy: true,
        argHints: { 0: 'agent', 1: 'account_label' },
    },
    {
        name: 'archetype_attr_sum',
        signature: 'archetype_attr_sum(agent, attr, country=...)',
        snippet: "archetype_attr_sum('${1:household}', '${2:c_intent}')",
        detail: '[legacy alias] Use agent_attr_sum.',
        legacy: true,
        argHints: { 0: 'agent' },
    },
    {
        name: 'archetype_attr_mean',
        signature: 'archetype_attr_mean(agent, attr, country=...)',
        snippet: "archetype_attr_mean('${1:household}', '${2:c_intent}')",
        detail: '[legacy alias] Use agent_attr_mean.',
        legacy: true,
        argHints: { 0: 'agent' },
    },
    // ---- legacy free-function composition primitives ----
    // These names DO appear in the proxy surface (as methods on
    // AgentsProxy / KpisProxy), so they're listed as legacy to nudge
    // toward the proxy method form.
    {
        name: 'agents',
        signature: 'agents(archetype=None, country=...)',
        snippet: "agents(archetype='${1:household}')",
        detail: '[legacy] Use agents.where(archetype=…).ids.',
        legacy: true,
        argHints: {},
    },
    {
        name: 'balances',
        signature: 'balances(archetype, account, country=...)',
        snippet: "balances('${1:household}', '${2:Deposits}')",
        detail: '[legacy] Use agents.where(archetype=…).balances(account).',
        legacy: true,
        argHints: { 0: 'archetype', 1: 'account_label' },
    },
    {
        name: 'attrs',
        signature: 'attrs(archetype, attr, country=...)',
        snippet: "attrs('${1:household}', '${2:c_intent}')",
        detail: '[legacy] Use agents.where(archetype=…).attrs(name).',
        legacy: true,
        argHints: { 0: 'archetype' },
    },
    {
        name: 'stocks',
        signature: "stocks(archetype, kind, type='Assets', country=...)",
        snippet: "stocks('${1:household}', '${2:deposits}')",
        detail: '[legacy] Use agents.where(archetype=…).stocks(kind).',
        legacy: true,
        argHints: { 0: 'archetype', 1: 'asset_kind', 2: 'enum:Assets|Liabilities|Equity' },
    },
    // ---- statistical reducers (empty-list-safe) ----
    {
        name: 'mean',
        signature: 'mean(xs)',
        snippet: 'mean(${1:xs})',
        detail: 'Arithmetic mean; 0 on empty.',
        argHints: {},
    },
    {
        name: 'median',
        signature: 'median(xs)',
        snippet: 'median(${1:xs})',
        detail: 'Median of an iterable; 0 on empty.',
        argHints: {},
    },
    {
        name: 'std',
        signature: 'std(xs)',
        snippet: 'std(${1:xs})',
        detail: 'Population standard deviation; 0 on n<2.',
        argHints: {},
    },
    {
        name: 'var',
        signature: 'var(xs)',
        snippet: 'var(${1:xs})',
        detail: 'Population variance; 0 on n<2.',
        argHints: {},
    },
    {
        name: 'count',
        signature: 'count(xs)',
        snippet: 'count(${1:xs})',
        detail: 'Length of an iterable (alias for len).',
        argHints: {},
    },
    {
        name: 'safe_div',
        signature: 'safe_div(a, b, default=0)',
        snippet: 'safe_div(${1:a}, ${2:b}, ${3:0})',
        detail: 'Division that returns `default` on division-by-zero.',
        argHints: {},
    },
];

/** Detect whether the caret sits inside a string literal that is the
 *  Nth argument of a function call. Used by the Monaco completion
 *  provider to switch from identifier completions to value
 *  completions (asset kinds, markets, …) at the right moments.
 *
 *  Returns `{fnName, argIndex, partial}` or null. `partial` is the
 *  bit of the string literal already typed (used to compute the
 *  replace-range for Monaco's completion).
 *
 *  Implementation: scan the prefix (text from line start up to the
 *  caret) left-to-right tracking quote state, then walk left from
 *  the open quote to find the enclosing `(` and arg index. */
export function stringArgContext(head) {
    let stringStart = -1;
    let stringQuote = null;
    for (let i = 0; i < head.length; i++) {
        const ch = head[i];
        if (stringStart >= 0) {
            if (ch === '\\') { i++; continue; }
            if (ch === stringQuote) {
                stringStart = -1;
                stringQuote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            stringStart = i;
            stringQuote = ch;
        }
    }
    if (stringStart < 0) return null;
    const partial = head.slice(stringStart + 1);

    let depth = 0;
    let argIndex = 0;
    let i = stringStart - 1;
    while (i >= 0 && /\s/.test(head[i])) i--;
    let inStr = false;
    let strCh = null;
    while (i >= 0) {
        const ch = head[i];
        if (inStr) {
            if (ch === strCh && head[i - 1] !== '\\') inStr = false;
            i--; continue;
        }
        if (ch === "'" || ch === '"') {
            inStr = true; strCh = ch; i--; continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') depth++;
        else if (ch === '(' || ch === '[' || ch === '{') {
            if (depth === 0) {
                if (ch !== '(') return null;
                let j = i - 1;
                while (j >= 0 && /[A-Za-z0-9_]/.test(head[j])) j--;
                const fnName = head.slice(j + 1, i);
                if (!fnName) return null;
                return { fnName, argIndex, partial };
            }
            depth--;
        } else if (ch === ',' && depth === 0) {
            argIndex++;
        }
        i--;
    }
    return null;
}

/** Lookup a helper by name. */
export function findHelper(name) {
    return PYTHON_HELPERS.find((h) => h.name === name) || null;
}

/** Detect whether the caret sits inside a function call (but NOT
 *  inside a string literal). Returns `{fnName, argIndex}` or null.
 *
 *  Complements `stringArgContext`: that one fires when the caret is
 *  inside a quoted argument; this one fires for bare positions
 *  (identifier or kwarg completion). The walker is the same — walk
 *  left from end-of-prefix tracking bracket depth and skipping
 *  string literals, then snap the identifier before the enclosing
 *  `(`. */
export function callContext(head) {
    // Bail if we are currently inside a string at the caret —
    // stringArgContext handles that case.
    let inString = false;
    let strQuote = null;
    for (let i = 0; i < head.length; i++) {
        const ch = head[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === strQuote) { inString = false; strQuote = null; }
            continue;
        }
        if (ch === "'" || ch === '"') { inString = true; strQuote = ch; }
    }
    if (inString) return null;

    let depth = 0;
    let argIndex = 0;
    let i = head.length - 1;
    let inStr = false;
    let strCh = null;
    while (i >= 0) {
        const ch = head[i];
        if (inStr) {
            if (ch === strCh && head[i - 1] !== '\\') inStr = false;
            i--; continue;
        }
        if (ch === "'" || ch === '"') {
            inStr = true; strCh = ch; i--; continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') depth++;
        else if (ch === '(' || ch === '[' || ch === '{') {
            if (depth === 0) {
                if (ch !== '(') return null;
                let j = i - 1;
                while (j >= 0 && /[A-Za-z0-9_]/.test(head[j])) j--;
                const fnName = head.slice(j + 1, i);
                if (!fnName) return null;
                return { fnName, argIndex };
            }
            depth--;
        } else if (ch === ',' && depth === 0) {
            argIndex++;
        }
        i--;
    }
    return null;
}

/** Extract kwarg names from a helper signature string.
 *
 *  E.g. `stock(kind, type='Assets', country=...)` → `['type', 'country']`.
 *  Names are everything matching `[A-Za-z_][A-Za-z0-9_]*=` inside the
 *  outer parens; positional-only params (no `=`) are skipped. */
export function parseKwargs(signature) {
    if (!signature) return [];
    const m = signature.match(/\(([\s\S]*)\)/);
    if (!m) return [];
    const body = m[1];
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    const out = [];
    let match;
    while ((match = re.exec(body)) !== null) {
        out.push(match[1]);
    }
    return out;
}


// =====================================================================
// HELP_RECIPES — the topic-organized cheat sheet shown in the Query
// and Watch tabs' Help panel. Each recipe is a (title, code) pair: the
// title says what it does in plain English, the code is the expression
// to insert into the editor on click.
//
// Curated around the common observability questions users actually
// have:
//   - "what's defined in this project?" (Configuration & spec)
//   - "what's the world doing right now?" (Live values)
//   - "what's in this registry / bus topic / agent variable?"
//
// Watch reuses these recipes — same vocabulary, just continuously
// evaluated — with WATCH_BREAK_RECIPES providing comparison-style
// expressions suited for the row's "break on true" toggle.
//
// The code snippets mirror the domain-proxy surface in
// `ecoagent/sim/expression_api.py` — keep them in sync when proxies
// gain or lose methods.
// =====================================================================

// Recipes use `{placeholder}` tokens — `{country}`, `{sector}`, `{agent}`,
// `{instance}`, `{market}`, `{kpi}`, `{registry}`, `{bus_topic}`,
// `{account}`, `{attr}`, `{asset_kind}`. The Query tab substitutes each
// token with a real id from the live project at render time (see
// `substituteRecipeCode` below). Recipes whose required tokens have no
// match in the current project are dimmed; clicking them inserts the
// raw template so the user sees what shape to fill in.

export const HELP_RECIPES = [
    {
        group: 'Browse what exists',
        hint: 'Each domain is a proxy — index by id, iterate, or filter with .where(...).',
        items: [
            { title: 'Countries',                      code: 'countries.ids' },
            { title: 'Sectors',                        code: 'sectors.ids' },
            { title: 'Agents (definitions)',           code: 'archetypes.ids' },
            { title: 'Agent instances (runtime)',      code: 'agents.ids' },
            { title: 'Markets',                        code: 'markets.ids' },
            { title: 'KPIs',                           code: 'kpis.ids' },
            { title: 'Bus topics published this tick', code: 'bus.ids' },
            { title: 'Registries',                     code: 'registries.ids' },
            { title: 'Scenarios',                      code: 'scenarios.ids' },
            { title: 'Currencies',                     code: 'currencies.ids' },
            { title: 'Current world tick',             code: 'world.tick' },
        ],
    },
    {
        group: 'Cross-references — walk from one domain to another',
        hint: 'Every entity exposes its neighbours as a proxy or another entity.',
        items: [
            { title: "A country's sectors",
              code: "countries['{country}'].sectors.ids" },
            { title: "A country's agents (definitions domiciled here)",
              code: "countries['{country}'].archetypes.ids" },
            { title: "A country's agent instances",
              code: "countries['{country}'].agents.count" },
            { title: "A country's KPIs",
              code: "countries['{country}'].kpis.ids" },
            { title: "A sector's country",
              code: "sectors['{sector}'].country.id" },
            { title: "A sector's agents (definitions)",
              code: "sectors['{sector}'].archetypes.ids" },
            { title: "A sector's agent instances",
              code: "sectors['{sector}'].agents.ids" },
            { title: "An agent's default sector",
              code: "archetypes['{agent}'].default_sector.id" },
            { title: "An agent's country",
              code: "archetypes['{agent}'].country.id" },
            { title: "An agent's instances",
              code: "archetypes['{agent}'].agents.ids" },
            { title: "An instance's agent",
              code: "agents['{instance}'].archetype.id" },
            { title: "An instance's sector",
              code: "agents['{instance}'].sector.id" },
            { title: "An instance's country",
              code: "agents['{instance}'].country.id" },
        ],
    },
    {
        group: 'Configuration & spec — read the project file',
        hint: "Static structure the project declared. Doesn't change between ticks.",
        items: [
            { title: 'Country label & currency',
              code: "countries['{country}'].currency.symbol" },
            { title: 'Sector kind (real / financial)',
              code: "sectors['{sector}'].kind" },
            { title: 'Agent population & default sector',
              code: "archetypes['{agent}'].population" },
            { title: 'Agent params (config knobs)',
              code: "archetypes['{agent}'].params" },
            { title: 'Agent account templates',
              code: "archetypes['{agent}'].accounts" },
            { title: 'Market kind',
              code: "markets['{market}'].kind_id" },
            { title: 'KPI source expression',
              code: "kpis['{kpi}'].expr" },
            { title: 'KPI unit & kind',
              code: "kpis['{kpi}'].unit" },
        ],
    },
    {
        group: 'Live values — read from the running world',
        hint: 'Changes every tick. In Watch these fire continuously; in Query they snapshot now.',
        items: [
            { title: 'Bus topic (last-published payload)',
              code: "bus('{bus_topic}')" },
            { title: 'Bus topic with default',
              code: "bus('{bus_topic}', 0.0)" },
            { title: 'Market last-cleared price',
              code: "markets['{market}'].price" },
            { title: 'Market last volume',
              code: "markets['{market}'].volume" },
            { title: 'Current KPI value',
              code: "kpis['{kpi}'].value" },
            { title: 'Previous-tick KPI value',
              code: "kpis['{kpi}'].prev" },
            { title: 'Country-wide stock (Assets side)',
              code: "countries['{country}'].stock('{asset_kind}')" },
            { title: 'Country-wide equity',
              code: "countries['{country}'].equity" },
        ],
    },
    {
        group: 'Registries — relational (rows + schema)',
        hint: 'For tables without a tick column — loans, accounts, etc. Use .by_id, .where, .count.',
        items: [
            { title: 'Every row in a registry',
              code: "registries('{registry}').all()" },
            { title: 'First few rows',
              code: "registries('{registry}').all()[:5]" },
            { title: 'Total row count',
              code: "len(registries('{registry}'))" },
            { title: 'Get one row by id',
              code: "registries('{registry}')['<row_id>']" },
            { title: 'Rows matching a field',
              code: "registries('{registry}').where(<field>=<value>)" },
            { title: 'Count rows matching a field',
              code: "registries('{registry}').count(<field>=<value>)" },
            { title: 'Inspect the schema',
              code: "registries('{registry}').schema" },
        ],
    },
    {
        group: 'Registries — time series (tick-indexed)',
        hint: 'For tables with a tick column — metrics, brain_history, events. Use latest / since / range / series.',
        items: [
            { title: 'Latest row (highest tick) matching a filter',
              code: "registries('{registry}').latest(<field>=<value>)" },
            { title: 'Latest row overall',
              code: "registries('{registry}').latest()" },
            { title: 'Rows from a tick onward',
              code: "registries('{registry}').since(<tick>)" },
            { title: 'Rows in a tick range',
              code: "registries('{registry}').range(<from_tick>, <to_tick>)" },
            { title: 'Time series of one column [(tick, value), …]',
              code: "registries('{registry}').series('<column>')" },
            { title: 'Time series since tick T',
              code: "registries('{registry}').series('<column>', since_tick=<T>)" },
            { title: 'Time series filtered + windowed',
              code: "registries('{registry}').series('<column>', since_tick=<T>, <field>=<value>)" },
            { title: 'Check shape at runtime',
              code: "registries('{registry}').is_time_series" },
        ],
    },
    {
        group: "One specific agent instance — read its variables",
        hint: "Index by instance id ('<agent>-<n>'). Exposes balance(), attr(), accounts.",
        items: [
            { title: 'Every account label this instance owns',
              code: "agents['{instance}'].accounts" },
            { title: 'Ledger balance for one account label',
              code: "agents['{instance}'].balance('{account}')" },
            { title: 'Scalar variable (param or brain field)',
              code: "agents['{instance}'].attr('{attr}')" },
            { title: "This instance's agent id",
              code: "agents['{instance}'].archetype.id" },
            { title: "This instance's sector id",
              code: "agents['{instance}'].sector.id" },
        ],
    },
    {
        group: 'Across an agent population — vectors & reductions',
        hint: 'Filter the population, read a vector, then reduce with mean / sum / gini / percentile.',
        items: [
            { title: 'Instance ids for an agent',
              code: "agents.where(agent='{agent}').ids" },
            { title: 'Population count',
              code: "agents.where(agent='{agent}').count" },
            { title: 'Per-instance balances',
              code: "agents.where(agent='{agent}').balances('{account}')" },
            { title: 'Per-instance variable',
              code: "agents.where(agent='{agent}').attrs('{attr}')" },
            { title: 'Mean balance',
              code: "mean(agents.where(agent='{agent}').balances('{account}'))" },
            { title: 'Wealth inequality (gini)',
              code: "gini(agents.where(agent='{agent}').balances('{account}'))" },
        ],
    },
];

/** Tokens the help recipes use; `_renderQueryScope` substitutes them
 *  with concrete ids from the live project. Order doesn't matter.
 *  `archetype` retained as a back-compat alias for `agent` so older
 *  saved recipes still resolve. */
export const RECIPE_TOKENS = [
    'country', 'sector', 'agent', 'instance', 'archetype',
    'market', 'kpi', 'registry', 'currency',
    'bus_topic', 'account', 'attr', 'asset_kind',
];

/** Substitute `{token}` placeholders in a recipe `code` template using
 *  the given map. Tokens with no entry in `tokenMap` are left as-is so
 *  the user can see what shape to fill in. Returns the substituted
 *  string AND a boolean indicating whether any token was left
 *  un-resolved (used by the UI to dim the recipe). */
export function substituteRecipeCode(code, tokenMap) {
    let missing = false;
    const out = code.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => {
        const v = tokenMap?.[key];
        if (v == null || v === '') { missing = true; return `{${key}}`; }
        return String(v);
    });
    return { code: out, missing };
}

// =====================================================================
// EXPRESSION_API_SHAPES — JS mirror of `ecoagent/sim/expression_api.py`.
//
// Drives the Monaco completion provider's attribute / subscript /
// where-kwarg completions. NOT a runtime — the actual eval happens in
// the bridge. Update both sides when proxies / entities change.
//
// Shape:
//   proxies['<name>'] = {
//       entity: 'agent',          // entity returned by [id] / .first
//       properties: [{name, type, detail}],
//       methods:    [{name, signature, snippet, detail}],
//       filters:    [{name, detail}],   // valid where(name=...) kwargs
//       callable:   true | false,       // can be called: agents(...), bus(...)
//       callSignature: 'agents(archetype=None, country=None)',
//   }
//   entities['<name>'] = {
//       properties: [...],
//       methods:    [...],
//   }
//
// The uniform proxy protocol (`ids`, `count`, `first`, `where`, `[id]`,
// `__len__`) is added on top automatically by `proxyShape()` below.
// =====================================================================

const _UNIFORM_PROXY_PROPS = [
    { name: 'ids',   type: 'list[str]', detail: 'Every id in this subset' },
    { name: 'count', type: 'int',       detail: 'Length of this subset' },
    { name: 'first', type: 'entity',    detail: 'First entity (or None when empty)' },
];

const _UNIFORM_PROXY_METHODS = [
    { name: 'where', signature: 'where(**filters)', snippet: 'where(${1:field}=${2:value})',
      detail: 'Filtered chainable subset' },
    { name: 'get',   signature: 'get(id, default=None)', snippet: "get('${1:id}')",
      detail: 'Resolve an entity by id with fallback' },
];

const EXPRESSION_API_PROXIES = {
    countries: {
        entity: 'country',
        properties: [],
        methods: [],
        filters: [
            { name: 'currency',     detail: 'Currency id' },
            { name: 'label',        detail: 'Display name' },
            { name: 'central_bank', detail: 'Central-bank archetype id' },
        ],
    },
    sectors: {
        entity: 'sector',
        properties: [],
        methods: [],
        filters: [
            { name: 'country', detail: 'Country id' },
            { name: 'kind',    detail: "Sector kind ('real' / 'financial' / 'government' / 'external')" },
            { name: 'label',   detail: 'Display name' },
        ],
    },
    archetypes: {
        entity: 'archetype',
        properties: [],
        methods: [],
        filters: [
            { name: 'default_sector', detail: 'Sector id this archetype is bound to' },
            { name: 'label',          detail: 'Display name' },
            { name: 'population',     detail: 'Declared population count' },
            { name: 'role',           detail: 'Engine role (bank / non_bank / central_bank / …)' },
            { name: 'builtin',        detail: 'true for built-in archetypes' },
        ],
    },
    agents: {
        entity: 'agent',
        callable: true,
        callSignature: 'agents(archetype=None, country=None)  # legacy — prefer .where',
        properties: [],
        methods: [
            { name: 'balances', signature: "balances(account, default=0.0)",
              snippet: "balances('${1:Deposits}')",
              detail: 'Per-agent balance vector — list[float]' },
            { name: 'attrs',    signature: "attrs(name, default=0.0)",
              snippet: "attrs('${1:wage}')",
              detail: 'Per-agent attribute vector — list[float]' },
            { name: 'stocks',   signature: "stocks(kind, type='Assets')",
              snippet: "stocks('${1:deposits}')",
              detail: 'Per-agent stock vector by asset_kind — list[float]' },
        ],
        filters: [
            { name: 'archetype', detail: 'Archetype id' },
            { name: 'country',   detail: 'Country id' },
            { name: 'sector_id', detail: 'Sector id' },
        ],
    },
    markets: {
        entity: 'market',
        properties: [],
        methods: [],
        filters: [
            { name: 'kind',  detail: 'Market kind' },
            { name: 'label', detail: 'Display name' },
        ],
    },
    kpis: {
        entity: 'kpi',
        properties: [],
        methods: [],
        filters: [
            { name: 'country', detail: 'Country scope (None for global)' },
            { name: 'kind',    detail: "KPI kind (e.g. 'ratio', 'level', 'flow')" },
            { name: 'unit',    detail: 'Unit string' },
            { name: 'label',   detail: 'Display name' },
        ],
    },
    scenarios: {
        entity: 'scenario',
        properties: [],
        methods: [],
        filters: [
            { name: 'label',       detail: 'Display name' },
            { name: 'description', detail: 'Free-text description' },
        ],
    },
    currencies: {
        entity: 'currency',
        properties: [],
        methods: [],
        filters: [
            { name: 'label',  detail: 'Display name' },
            { name: 'symbol', detail: 'Symbol (e.g. €, $)' },
        ],
    },
    dashboards: {
        entity: 'dashboard',
        properties: [],
        methods: [],
        filters: [
            { name: 'label', detail: 'Display name' },
        ],
    },
    bus: {
        entity: null,
        callable: true,
        callSignature: 'bus(topic, default=0.0)',
        properties: [
            { name: 'topics', type: 'list[str]', detail: 'Every published topic this tick' },
            { name: 'ids',    type: 'list[str]', detail: 'Alias of .topics (uniform grammar)' },
            { name: 'count',  type: 'int',       detail: 'Number of published topics' },
            { name: 'first',  type: 'str|None',  detail: 'First topic id' },
        ],
        methods: [
            { name: 'query',   signature: "query(topic, default=0.0)",
              snippet: "query('${1:topic}')",
              detail: 'Read a prior-tick payload (same as calling bus(topic))' },
            { name: 'history', signature: "history(topic, n=10)",
              snippet: "history('${1:topic}', ${2:10})",
              detail: 'Recent payloads for a topic (stub — returns [latest])' },
        ],
        filters: [],
    },
    registries: {
        entity: 'registry_query',
        callable: true,
        callSignature: 'registries(id)',
        properties: [
            { name: 'keys',  type: 'list[str]', detail: 'Registry ids declared on this world' },
            { name: 'ids',   type: 'list[str]', detail: 'Alias of .keys (uniform grammar)' },
            { name: 'count', type: 'int',       detail: 'Number of registries' },
            { name: 'first', type: 'registry_query|None', detail: 'First registry query' },
        ],
        methods: [],
        filters: [],
    },
    world: {
        entity: null,
        properties: [
            { name: 'tick',   type: 'int',  detail: 'Current world tick' },
            { name: 'time',   type: 'any',  detail: 'World clock object' },
            { name: 'config', type: 'any',  detail: 'Live ProjectConfig' },
        ],
        methods: [
            { name: 'stock',  signature: "stock(kind, type='Assets', country=None)",
              snippet: "stock('${1:deposits}')",
              detail: 'Total stock across all countries (or one)' },
            { name: 'equity', signature: "equity(country=None)",
              snippet: "equity()",
              detail: 'Total equity (or per-country)' },
        ],
        filters: [],
    },
};

const EXPRESSION_API_ENTITIES = {
    country: {
        properties: [
            { name: 'id',         type: 'str',          detail: 'Country id' },
            { name: 'label',      type: 'str',          detail: 'Display name' },
            { name: 'currency',   type: 'currency',     detail: 'CurrencyEntity for this country' },
            { name: 'equity',     type: 'float',        detail: 'Total equity in this country' },
            { name: 'agents',     type: 'proxy:agents', detail: 'Agents domiciled here' },
            { name: 'sectors',    type: 'proxy:sectors', detail: 'Sectors in this country' },
            { name: 'kpis',       type: 'proxy:kpis',   detail: 'KPIs scoped to this country' },
            { name: 'archetypes', type: 'proxy:archetypes', detail: 'Archetypes domiciled here' },
        ],
        methods: [
            { name: 'stock', signature: "stock(kind, type='Assets')",
              snippet: "stock('${1:deposits}')",
              detail: 'Sum of ledger balances inside this country' },
        ],
    },
    sector: {
        properties: [
            { name: 'id',         type: 'str',          detail: 'Sector id' },
            { name: 'label',      type: 'str',          detail: 'Display name' },
            { name: 'kind',       type: 'str',          detail: 'Sector kind' },
            { name: 'country',    type: 'country',      detail: 'Country this sector belongs to' },
            { name: 'currency',   type: 'currency',     detail: 'Currency resolved from the country' },
            { name: 'agents',     type: 'proxy:agents', detail: 'Agents in this sector' },
            { name: 'archetypes', type: 'proxy:archetypes', detail: 'Archetypes bound to this sector' },
        ],
        methods: [
            { name: 'stock', signature: "stock(kind, type='Assets')",
              snippet: "stock('${1:deposits}')",
              detail: 'Sum of ledger balances filed under this sector' },
        ],
    },
    archetype: {
        properties: [
            { name: 'id',             type: 'str',          detail: 'Archetype id' },
            { name: 'label',          type: 'str',          detail: 'Display name' },
            { name: 'population',     type: 'int',          detail: 'Declared population' },
            { name: 'default_sector', type: 'sector',       detail: 'Default sector binding' },
            { name: 'country',        type: 'country',      detail: "Country of the archetype's default sector" },
            { name: 'accounts',       type: 'list[dict]',   detail: 'Account templates' },
            { name: 'params',         type: 'list[dict]',   detail: 'Parameter specs (config knobs)' },
            { name: 'agents',         type: 'proxy:agents', detail: 'Live instances of this archetype' },
        ],
        methods: [],
    },
    agent: {
        properties: [
            { name: 'id',        type: 'str',       detail: 'Agent id' },
            { name: 'archetype', type: 'archetype', detail: 'Archetype this agent is an instance of' },
            { name: 'sector',    type: 'sector',    detail: 'Sector this agent is filed under' },
            { name: 'country',   type: 'country',   detail: "Agent's country" },
            { name: 'accounts',  type: 'list[str]', detail: 'Account labels this agent owns' },
        ],
        methods: [
            { name: 'balance', signature: "balance(account, default=0.0)",
              snippet: "balance('${1:Deposits}')",
              detail: 'Ledger balance for one account label' },
            { name: 'attr',    signature: "attr(name, default=0.0)",
              snippet: "attr('${1:wage}')",
              detail: 'Scalar attribute (param or brain field)' },
        ],
    },
    market: {
        properties: [
            { name: 'id',     type: 'str',         detail: 'Market id' },
            { name: 'label',  type: 'str',         detail: 'Display name' },
            { name: 'kind',   type: 'str',         detail: 'Market kind' },
            { name: 'price',  type: 'float|None',  detail: 'Last-cleared price (None if never cleared)' },
            { name: 'volume', type: 'float',       detail: 'Last-cleared volume' },
        ],
        methods: [],
    },
    kpi: {
        properties: [
            { name: 'id',      type: 'str',     detail: 'KPI id' },
            { name: 'label',   type: 'str',     detail: 'Display name' },
            { name: 'kind',    type: 'str',     detail: 'KPI kind' },
            { name: 'unit',    type: 'str',     detail: 'Unit string' },
            { name: 'country', type: 'country', detail: 'Scope country (None for global)' },
            { name: 'expr',    type: 'str',     detail: 'Source expression' },
            { name: 'value',   type: 'float',   detail: 'Current-tick value' },
            { name: 'prev',    type: 'float',   detail: 'Previous-tick value' },
        ],
        methods: [],
    },
    scenario: {
        properties: [
            { name: 'id',          type: 'str',  detail: 'Scenario id' },
            { name: 'label',       type: 'str',  detail: 'Display name' },
            { name: 'description', type: 'str',  detail: 'Free-text description' },
            { name: 'overrides',   type: 'dict', detail: 'Overrides dict' },
        ],
        methods: [
            { name: 'apply', signature: "apply()",
              snippet: "apply()",
              detail: 'Write — read-only scope: raises ReadOnlyError' },
        ],
    },
    currency: {
        properties: [
            { name: 'id',             type: 'str',    detail: 'Currency id' },
            { name: 'label',          type: 'str',    detail: 'Display name' },
            { name: 'symbol',         type: 'str',    detail: 'Symbol (€, $, …)' },
            { name: 'issuer_sector',  type: 'sector', detail: 'Issuer sector if declared' },
        ],
        methods: [],
    },
    dashboard: {
        properties: [
            { name: 'id',     type: 'str',         detail: 'Dashboard id' },
            { name: 'label',  type: 'str',         detail: 'Display name' },
            { name: 'charts', type: 'list[dict]',  detail: 'Chart specs' },
        ],
        methods: [],
    },
    registry_query: {
        properties: [],
        methods: [
            { name: 'all',   signature: "all()",
              snippet: "all()",
              detail: 'Every row — list[dict]' },
            { name: 'where', signature: "where(**filters)",
              snippet: "where(${1:field}=${2:value})",
              detail: 'Rows matching filters — list[dict]' },
            { name: 'count', signature: "count(**filters)",
              snippet: "count()",
              detail: 'Count rows matching filters' },
        ],
    },
};

/** Compose the uniform protocol on top of the per-proxy data. */
export function proxyShape(name) {
    const base = EXPRESSION_API_PROXIES[name];
    if (!base) return null;
    return {
        ...base,
        properties: [..._UNIFORM_PROXY_PROPS, ...(base.properties || [])],
        methods:    [..._UNIFORM_PROXY_METHODS, ...(base.methods || [])],
    };
}

export function entityShape(name) {
    return EXPRESSION_API_ENTITIES[name] || null;
}

export const PROXY_NAMES  = Object.keys(EXPRESSION_API_PROXIES);
export const ENTITY_NAMES = Object.keys(EXPRESSION_API_ENTITIES);


/** Parse the receiver of an attribute access at the caret. Returns
 *  `{kind: 'proxy', name}`, `{kind: 'entity', name}` or null.
 *
 *  Recognises:
 *    `<ident>.`                      → proxy
 *    `<ident>['...'].`               → entity (proxy's entity_cls)
 *    `<ident>["..."].`               → entity
 *    `<ident>.where(...).`           → proxy (filtered subset, same shape)
 *    `<ident>.first.`                → entity
 *    `<ident>['...'].<prop>.`        → entity property's type (recursive)
 *    `country.` (when scope has it)  → entity:country
 *
 *  Implementation: walk back from the dot, tokenise once. Tracks
 *  parens / brackets so suffix-style chains work. */
export function receiverAtCaret(prefixUpToDot) {
    // Strip trailing whitespace and the dot itself.
    let s = prefixUpToDot.replace(/\.\s*$/, '');
    if (!s) return null;
    // Peel suffixes right-to-left until we hit a bare identifier.
    let entityHop = false;
    let proxyHop  = false;
    for (;;) {
        const m = s.match(/\.(first|where\s*\([^)]*\))\s*$/);
        if (m) {
            if (m[1] === 'first') entityHop = true;
            else proxyHop = true;       // .where() preserves proxy type
            s = s.slice(0, m.index);
            continue;
        }
        const sub = s.match(/\[\s*(['"])[^'"]*\1\s*\]\s*$/);
        if (sub) {
            entityHop = true;
            s = s.slice(0, sub.index);
            continue;
        }
        // Trailing call form `name(...)`. Special-case the two callable
        // proxies whose call returns a useful receiver:
        //   - `registries('id')` → registry_query entity
        //   - `bus('topic')` → scalar (no further completion)
        // Other calls (`agents('worker')`, helper functions) yield
        // collections / scalars we don't drill into.
        const call = s.match(/(\w+)\s*\([^)]*\)\s*$/);
        if (call) {
            if (call[1] === 'registries') {
                return { kind: 'entity', name: 'registry_query' };
            }
            return null;
        }
        break;
    }
    // Now `s` should end in a bare identifier (possibly preceded by
    // `entity.<prop>.…` chains we can't statically resolve without
    // walking property types). Recursive resolution stays simple:
    // match the last `.<prop>` and resolve via entity shapes.
    const idMatch = s.match(/(\w+)\s*$/);
    if (!idMatch) return null;
    const head = idMatch[1];

    // Case A: head is a top-level proxy name.
    if (EXPRESSION_API_PROXIES[head]) {
        if (entityHop) {
            const entity = EXPRESSION_API_PROXIES[head].entity;
            return entity ? { kind: 'entity', name: entity } : null;
        }
        // proxyHop OR no hop: still a proxy.
        return { kind: 'proxy', name: head };
    }
    // Case B: bare `country` — the auto-bound CountryEntity in scope.
    if (head === 'country') {
        return { kind: 'entity', name: 'country' };
    }
    // Case C: dotted chain (`countries['x'].agents.`). Walk the chain
    // forward: pick the deepest preceding receiver and resolve via
    // its entity's property types.
    //
    // To resolve `<expr>.<prop>.`, we need (a) the receiver of `<expr>`
    // and (b) the type of `<prop>` on that receiver. Recursive call
    // on the prefix handles arbitrary chains.
    const dotIdx = s.lastIndexOf('.');
    if (dotIdx < 0) return null;
    const inner = receiverAtCaret(s.slice(0, dotIdx + 1));
    if (!inner) return null;
    const prop = s.slice(dotIdx + 1).trim();
    if (inner.kind === 'proxy') {
        const sh = proxyShape(inner.name);
        const p = sh?.properties.find((x) => x.name === prop);
        return _typeToReceiver(p?.type);
    }
    if (inner.kind === 'entity') {
        const sh = entityShape(inner.name);
        const p = sh?.properties.find((x) => x.name === prop);
        return _typeToReceiver(p?.type);
    }
    return null;
}

function _typeToReceiver(type) {
    if (!type) return null;
    if (type.startsWith('proxy:')) return { kind: 'proxy', name: type.slice(6) };
    if (EXPRESSION_API_ENTITIES[type]) return { kind: 'entity', name: type };
    return null;
}

/** When the caret sits inside `<ident>['…']` or `<ident>["…"]`, return
 *  the proxy name and the partial string typed so far. Used to drive
 *  id completion inside the subscript bracket. */
export function subscriptIdContext(head) {
    // We're inside a string literal at the very end of `head`.
    const sm = head.match(/(\w+)\s*\[\s*(['"])([^'"]*)$/);
    if (!sm) return null;
    const ident = sm[1];
    if (!EXPRESSION_API_PROXIES[ident]) return null;
    return { proxy: ident, partial: sm[3] };
}

/** When the caret sits inside `<ident>.where(<here>)`, return the
 *  proxy name. Used to drive kwarg completion. */
export function whereKwargContext(head) {
    // Walk back from end-of-prefix, find the innermost `(` whose
    // immediately-preceding token is `<ident>.where`.
    // Skip when inside a string literal.
    let inStr = false; let strCh = null;
    for (let i = 0; i < head.length; i++) {
        const ch = head[i];
        if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === strCh) { inStr = false; strCh = null; }
            continue;
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; }
    }
    if (inStr) return null;

    let depth = 0;
    let i = head.length - 1;
    while (i >= 0) {
        const ch = head[i];
        if (ch === ')' || ch === ']' || ch === '}') depth++;
        else if (ch === '(' || ch === '[' || ch === '{') {
            if (depth === 0) {
                if (ch !== '(') return null;
                // Look for `.where` immediately before the (.
                const left = head.slice(0, i);
                const m = left.match(/(\w+)\s*\.\s*where\s*$/);
                if (!m) return null;
                const ident = m[1];
                if (!EXPRESSION_API_PROXIES[ident]) return null;
                return { proxy: ident };
            }
            depth--;
        }
        i--;
    }
    return null;
}


/** Watch-specific extras: turn the live recipes above into comparison
 *  expressions suited for the row's "break on true" toggle. */
export const WATCH_BREAK_RECIPES = [
    { title: 'Bus topic crosses a threshold',
      code: "bus('rates.policy') > 0.05" },
    { title: 'KPI exceeds a target',
      code: "kpis['inflation'].value > 0.03" },
    { title: 'Agent reserves go negative',
      code: "agents['banker-0'].balance('Reserves') < 0" },
    { title: 'Inequality jumps tick-over-tick',
      code: "kpis['gini_deposits'].value - kpis['gini_deposits'].prev > 0.05" },
    { title: 'Registry row count crosses N',
      code: "registries('loans').count() > 50" },
    { title: 'Any agent variable above threshold',
      code: "any(x > 100 for x in agents.where(archetype='worker').attrs('wage'))" },
];
