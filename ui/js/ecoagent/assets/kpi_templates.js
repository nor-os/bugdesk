/**
 * kpi_templates.js — bundled fallback for the KPI template library.
 *
 * Mirrors `ecoagent/sim/sfc/assets/kpi_templates.json`. The bridge's
 * `kpi_templates_list()` is the canonical source; this module is the
 * graceful fallback used when:
 *   - the running pywebview proxy was built before the endpoint
 *     existed (cold start of an older Python process), or
 *   - the bridge call fails for any other reason.
 *
 * Keep in sync with the JSON — same shape ({id, label, category,
 * kind, unit, expr, params, description}). Changes to the canonical
 * file should be mirrored here so the two surfaces don't drift.
 */
export const DEFAULT_KPI_TEMPLATES = [
    {
        id: "money_supply", label: "Money supply (M1)", category: "Money",
        kind: "stock", unit: "",
        expr: "country.stock({deposit_kind}) + country.stock({cash_kind})",
        params: [
            { name: "deposit_kind", label: "Deposit asset kind", type: "asset_kind",
              default: "deposits", hint: "Which asset kind represents bank-issued deposits." },
            { name: "cash_kind", label: "Cash asset kind", type: "asset_kind",
              default: "cash", hint: "Which asset kind represents physical / CB money held by non-banks." },
        ],
        description: "Bank-issued deposits + physical cash held inside the country. The endogenous-money M1.",
    },
    {
        id: "credit_outstanding", label: "Credit outstanding", category: "Credit",
        kind: "stock", unit: "",
        expr: "country.stock({loan_kind})",
        params: [
            { name: "loan_kind", label: "Loan asset kind", type: "asset_kind",
              default: "loans", hint: "Asset kind banks book on the asset side when they extend credit." },
        ],
        description: "Total loan assets booked by banks in the country.",
    },
    {
        id: "net_credit_flow", label: "Net credit flow", category: "Credit",
        kind: "flow", unit: "",
        expr: "country.stock({loan_kind}) - kpis['{credit_outstanding_kpi}'].prev",
        params: [
            { name: "loan_kind", label: "Loan asset kind", type: "asset_kind", default: "loans" },
            { name: "credit_outstanding_kpi", label: "Companion credit-outstanding KPI", type: "kpi",
              hint: "A KPI that captures last-tick total loan stock. Pair with `credit_outstanding`." },
        ],
        description: "Tick-over-tick change in loan stock — net new lending this tick. Reads the prior tick from a companion KPI rather than the raw stock so the value survives a same-tick recompute. For the Biggs-Mayer/Keen \"credit impulse\" (acceleration, GDP-normalized), see the `credit_impulse` template.",
    },
    {
        id: "credit_impulse", label: "Credit impulse", category: "Credit",
        kind: "ratio", unit: "frac",
        expr: "({net_credit_flow_kpi} - kpis['{net_credit_flow_kpi}'].prev) / {gdp_kpi}",
        params: [
            { name: "net_credit_flow_kpi", label: "Net-credit-flow KPI", type: "kpi",
              hint: "An already-defined KPI capturing tick-over-tick Δloans (net new lending). Author it first — see `net_credit_flow`." },
            { name: "gdp_kpi", label: "Nominal GDP KPI", type: "kpi",
              hint: "An already-defined current-tick nominal-GDP KPI. Author it first — see `nominal_gdp`." },
        ],
        description: "Biggs-Mayer / Keen credit impulse: the ACCELERATION of net new lending, normalized by GDP — the metric that actually leads GDP growth in the Minsky/Keen literature. Not to be confused with `net_credit_flow`, the plain Δloans this is derived from.",
    },
    {
        id: "household_leverage", label: "Household leverage", category: "Credit",
        kind: "ratio", unit: "frac",
        expr: "country.stock({loan_kind}, type='Liabilities') / country.stock({deposit_kind})",
        params: [
            { name: "loan_kind", label: "Loan asset kind", type: "asset_kind", default: "loans" },
            { name: "deposit_kind", label: "Deposit asset kind", type: "asset_kind", default: "deposits" },
        ],
        description: "Household-side loan liabilities / deposits. Minsky financial-stability metric.",
    },
    {
        id: "firm_leverage", label: "Firm leverage", category: "Credit",
        kind: "ratio", unit: "frac",
        expr: "country.stock({loan_kind}, type='Liabilities') / country.equity",
        params: [
            { name: "loan_kind", label: "Loan asset kind", type: "asset_kind", default: "loans" },
        ],
        description: "Firm liabilities / equity. Credit-rationing trigger.",
    },
    {
        id: "policy_rate", label: "Policy rate", category: "Money",
        kind: "rate", unit: "frac/yr",
        expr: "bus({policy_rate_topic}, 0.0)",
        params: [
            { name: "policy_rate_topic", label: "Policy rate bus topic", type: "bus_topic",
              default: "rates.policy",
              hint: "The InfoBus topic the central bank publishes its rate on." },
        ],
        description: "Central-bank policy rate read off the InfoBus.",
    },
    {
        id: "interbank_rate", label: "Interbank rate", category: "Money",
        kind: "rate", unit: "frac/yr",
        expr: "bus({interbank_topic}, 0.0)",
        params: [
            { name: "interbank_topic", label: "Interbank rate bus topic", type: "bus_topic",
              default: "rates.interbank" },
        ],
        description: "Last-cleared overnight rate on the interbank market.",
    },
    {
        id: "real_interest_rate", label: "Real interest rate", category: "Money",
        kind: "rate", unit: "frac/yr",
        expr: "bus({policy_rate_topic}, 0.0) - kpis['{inflation_kpi}'].prev",
        params: [
            { name: "policy_rate_topic", label: "Policy rate bus topic", type: "bus_topic",
              default: "rates.policy" },
            { name: "inflation_kpi", label: "Inflation KPI", type: "kpi",
              hint: "An already-defined inflation KPI in the same scope. Author it first." },
        ],
        description: "Fisher: real = nominal − inflation. Requires an `inflation` KPI already defined.",
    },
    {
        id: "velocity_of_money", label: "Velocity of money", category: "Money",
        kind: "ratio", unit: "",
        expr: "bus({gdp_topic}, 0.0) / (country.stock({deposit_kind}) + country.stock({cash_kind}))",
        params: [
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
            { name: "deposit_kind", label: "Deposit asset kind", type: "asset_kind", default: "deposits" },
            { name: "cash_kind", label: "Cash asset kind", type: "asset_kind", default: "cash" },
        ],
        description: "Income velocity: GDP / M1.",
    },
    {
        id: "market_price", label: "Market price", category: "Prices",
        kind: "price", unit: "",
        expr: "markets[{market}].price or 0.0",
        params: [
            { name: "market", label: "Market", type: "market",
              hint: "Which market's last-clear mid this KPI tracks." },
        ],
        description: "Last-cleared mid on the chosen market.",
    },
    {
        id: "market_inflation", label: "Market price inflation", category: "Prices",
        kind: "rate", unit: "frac/yr",
        expr: "((markets[{market}].price or 0.0) - kpis['{price_kpi}'].prev) / kpis['{price_kpi}'].prev * 365",
        params: [
            { name: "market", label: "Market", type: "market",
              hint: "Which market's price to track." },
            { name: "price_kpi", label: "Companion price KPI", type: "kpi",
              hint: "A KPI that already captures the same market's price (uses its prior-tick value for the denominator)." },
        ],
        description: "Tick-over-tick price growth on a market, annualised. Pair with a `market_price` KPI authored first.",
    },
    {
        id: "gdp_growth", label: "GDP growth", category: "Output",
        kind: "rate", unit: "frac/yr",
        expr: "(bus({gdp_topic}, 0.0) - kpis['{gdp_kpi}'].prev) / kpis['{gdp_kpi}'].prev * 365",
        params: [
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
            { name: "gdp_kpi", label: "Companion nominal-GDP KPI", type: "kpi",
              hint: "A KPI that captures the GDP level (we need its prior-tick value)." },
        ],
        description: "Per-tick growth in nominal GDP, annualised.",
    },
    {
        id: "nominal_gdp", label: "Nominal GDP", category: "Output",
        kind: "flow", unit: "",
        expr: "bus({gdp_topic}, 0.0)",
        params: [
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Per-tick nominal GDP read off the InfoBus. Bridges to whatever agent / world-model code publishes the topic.",
    },
    {
        id: "investment_to_gdp", label: "Investment / GDP", category: "Output",
        kind: "ratio", unit: "frac",
        expr: "bus({investment_topic}, 0.0) / bus({gdp_topic}, 1.0)",
        params: [
            { name: "investment_topic", label: "Investment bus topic", type: "bus_topic",
              default: "economy.investment" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Real-economy capital accumulation, scaled by nominal output.",
    },
    {
        id: "unemployment_rate", label: "Unemployment rate", category: "Labour",
        kind: "rate", unit: "frac",
        expr: "max(0, 1 - archetypes[{employed_archetype}].agents.count / archetypes[{workforce_archetype}].agents.count)",
        params: [
            { name: "employed_archetype", label: "Employed-worker archetype", type: "archetype",
              hint: "Archetype whose population represents currently-employed workers." },
            { name: "workforce_archetype", label: "Total-workforce archetype", type: "archetype",
              hint: "Archetype whose population represents the entire labour force." },
        ],
        description: "Workers not currently employed as a fraction of the labour force.",
    },
    {
        id: "wage_share", label: "Wage share", category: "Distribution",
        kind: "ratio", unit: "frac",
        expr: "bus({wage_bill_topic}, 0.0) / bus({gdp_topic}, 1.0)",
        params: [
            { name: "wage_bill_topic", label: "Wage-bill bus topic", type: "bus_topic",
              default: "economy.wage_bill" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Aggregate wage bill divided by nominal output (Kalecki / Flassbeck).",
    },
    {
        id: "profit_share", label: "Profit share", category: "Distribution",
        kind: "ratio", unit: "frac",
        expr: "1 - bus({wage_bill_topic}, 0.0) / bus({gdp_topic}, 1.0)",
        params: [
            { name: "wage_bill_topic", label: "Wage-bill bus topic", type: "bus_topic",
              default: "economy.wage_bill" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Functional income going to capital (1 - wage share).",
    },
    {
        id: "rentier_share", label: "Rentier share", category: "Distribution",
        kind: "ratio", unit: "frac",
        expr: "(bus({interest_topic}, 0.0) + bus({dividend_topic}, 0.0)) / bus({gdp_topic}, 1.0)",
        params: [
            { name: "interest_topic", label: "Interest-income bus topic", type: "bus_topic",
              default: "economy.interest_income" },
            { name: "dividend_topic", label: "Dividend-income bus topic", type: "bus_topic",
              default: "economy.dividend_income" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Interest + dividend income as a share of GDP — financialisation metric.",
    },
    {
        id: "debt_to_gdp", label: "Debt / GDP", category: "Credit",
        kind: "ratio", unit: "frac",
        expr: "country.stock({bond_kind}, type='Liabilities') / (bus({gdp_topic}, 1.0) * 365)",
        params: [
            { name: "bond_kind", label: "Government-bond asset kind", type: "asset_kind",
              default: "bonds" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Government bond liabilities scaled by nominal output.",
    },
    {
        id: "credit_to_gdp", label: "Credit / GDP", category: "Credit",
        kind: "ratio", unit: "frac",
        expr: "country.stock({loan_kind}) / (bus({gdp_topic}, 1.0) * 365)",
        params: [
            { name: "loan_kind", label: "Loan asset kind", type: "asset_kind", default: "loans" },
            { name: "gdp_topic", label: "GDP bus topic", type: "bus_topic", default: "economy.gdp" },
        ],
        description: "Outstanding bank credit scaled by nominal output. Minsky cycle headline.",
    },
    {
        id: "current_account", label: "Current account", category: "External",
        kind: "flow", unit: "",
        expr: "bus({exports_topic}, 0.0) - bus({imports_topic}, 0.0)",
        params: [
            { name: "exports_topic", label: "Exports bus topic", type: "bus_topic",
              default: "economy.exports" },
            { name: "imports_topic", label: "Imports bus topic", type: "bus_topic",
              default: "economy.imports" },
        ],
        description: "Net exports — the external balance.",
    },
];

/** Canonical bus topics the engine publishes — surfaced to the
 *  scope sidebar's "Bus topics" group. */
export const KNOWN_BUS_TOPICS = [
    { topic: "rates.policy",              label: "Central-bank policy rate" },
    { topic: "rates.interbank",           label: "Interbank cleared rate" },
    { topic: "rates.iorb",                label: "IORB" },
    { topic: "rates.corridor.ceiling",    label: "Corridor ceiling" },
    { topic: "rates.corridor.floor",      label: "Corridor floor" },
    { topic: "economy.gdp",               label: "Nominal GDP (per-tick)" },
    { topic: "economy.wage_bill",         label: "Aggregate wage bill" },
    { topic: "economy.investment",        label: "Aggregate investment" },
    { topic: "economy.interest_income",   label: "Aggregate interest income" },
    { topic: "economy.dividend_income",   label: "Aggregate dividend income" },
    { topic: "economy.exports",           label: "Aggregate exports" },
    { topic: "economy.imports",           label: "Aggregate imports" },
    { topic: "prices.bonds_secondary",    label: "Bond-secondary mid" },
    { topic: "bonds.primary.curve",       label: "Primary-auction yield curve (JSON)" },
];
