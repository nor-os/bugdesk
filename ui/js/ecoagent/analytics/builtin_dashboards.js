/**
 * builtin_dashboards.js — preset dashboards shipped with the app.
 *
 * Every chart is an Ecosim PlotTile (`type: 'plot'`) carrying the
 * PlotCell config shape:
 *
 *   {
 *     layout: '1x1' | '1x2' | '2x1' | '2x2' | '1x3' | 'wide-top' | 'wide-bottom',
 *     subplots: [{
 *       displayName, chartType: 'line'|'area'|'bar'|'area-stacked',
 *       legendPosition, interpolation, nanHandling, showDataPoints,
 *       xAxis: { useTime: true },
 *       yAxes: [{ id, label, scale, position, series: [{
 *         id, variable, label, color, lineWidth, lineStyle, stackGroup
 *       }] }],
 *     }],
 *   }
 *
 * Variable naming convention (matches dashboard_tab.js#analyticsTreeToSymbols):
 *   "<source_id>.<property>"               for source-direct properties
 *   "<source_id>.<product>.<property>"     for product-bearing markets
 *
 * The grid (TileGrid) entries carry `id, type, x, y, w, h, config` where
 * `type` is always 'plot' and `config` is the PlotCell config above.
 */

const SCENARIOS = 'scenarios';
const ECONOMY = 'economy';
const BANKING = 'banking';
const MARKETS = 'markets';
const GOVCB   = 'govcb';
const FIRMS   = 'firms';

// Scenario ids the Mosler reference project ships with. Non-Mosler
// projects silently ignore unknown ids (the dashboard filters
// compare.scenarios against the actual scenarios list at render
// time — see _scenariosForSubplot).
const MOSLER_SCENARIOS = ['baseline', 'classic', 'mmt_dmark', 'mixed'];

let _sid = 0;
function sid(prefix) { return `${prefix}-${++_sid}`; }

/** Single-subplot line plot — the workhorse template. */
function linePlot(id, x, y, w, h, displayName, series) {
    return {
        id, type: 'plot', x, y, w, h,
        config: {
            layout: '1x1',
            subplots: [{
                id: sid('sp'),
                displayName,
                chartType: 'line',
                legendPosition: series.length > 1 ? 'bottom' : 'hidden',
                interpolation: 'linear',
                nanHandling: 'gap',
                showDataPoints: false,
                xAxis: { useTime: true, variable: '' },
                yAxes: [{
                    id: sid('y'),
                    label: '',
                    scale: 'linear',
                    position: 'left',
                    min: null, max: null, step: null,
                    series: series.map((s) => ({
                        id: sid('s'),
                        variable:  s.variable,
                        label:     s.label || '',
                        color:     s.color || '',
                        lineWidth: 1.6,
                        lineStyle: 'solid',
                    })),
                }],
            }],
        },
    };
}

/** Stacked area variant. */
function areaStacked(id, x, y, w, h, displayName, series) {
    const plot = linePlot(id, x, y, w, h, displayName, series);
    const sp = plot.config.subplots[0];
    sp.chartType = 'area-stacked';
    for (const s of sp.yAxes[0].series) s.stackGroup = 'main';
    return plot;
}

/** Bar plot variant. */
function barPlot(id, x, y, w, h, displayName, series) {
    const plot = linePlot(id, x, y, w, h, displayName, series);
    plot.config.subplots[0].chartType = 'bar';
    return plot;
}

/** Convenience for a (variable, label, colour) series entry. */
const S = (variable, label = '', color = '') => ({ variable, label, color });

/** Wraps `linePlot` and slots in a compare block. The legend goes
 *  to the bottom unconditionally — compare-mode plots draw multiple
 *  lines per series so the legend tells the user which scenario is
 *  which. */
function scenariosPlot(id, x, y, w, h, displayName, series, compare) {
    const plot = linePlot(id, x, y, w, h, displayName, series);
    plot.config.subplots[0].compare = compare;
    plot.config.subplots[0].legendPosition = 'bottom';
    return plot;
}

/** Like `linePlot` but also wires named-constant reference lines
 *  to the (just-generated) y-axis id. The constant names are
 *  resolved at render time by the dashboard's
 *  `_expandedRenderConfig` — see dashboard_tab.js. */
function refLinesPlot(id, x, y, w, h, displayName, series, refLines) {
    const yId = sid('y');
    return {
        id, type: 'plot', x, y, w, h,
        config: {
            layout: '1x1',
            subplots: [{
                id: sid('sp'),
                displayName,
                chartType: 'line',
                legendPosition: 'bottom',
                interpolation: 'linear',
                nanHandling: 'gap',
                showDataPoints: false,
                xAxis: { useTime: true, variable: '' },
                yAxes: [{
                    id: yId,
                    label: '',
                    scale: 'linear',
                    position: 'left',
                    min: null, max: null, step: null,
                    series: series.map((s) => ({
                        id: sid('s'),
                        variable: s.variable, label: s.label || '',
                        color: s.color || '',
                        lineWidth: 1.6, lineStyle: 'solid',
                    })),
                }],
                referenceLines: refLines.map((r) => ({
                    id: sid('rl'),
                    yAxisId: yId,
                    ...r,
                })),
            }],
        },
    };
}


/** Scenarios — the side-by-side comparison preset.
 *
 *  Two compare-mode showcase plots (overlay + delta) and one reference-
 *  lines showcase plot that anchors horizontal thresholds to named
 *  constants (`central_bank.policy_rate` etc.) so the lines track the
 *  project as it's retuned. This is the canonical landing page for
 *  "what does the dashboard actually do beyond plotting one world". */
const SCENARIOS_DASH = {
    id: SCENARIOS,
    label: 'Scenarios — compare',
    description:
        'Side-by-side comparison of every batched scenario plus a '
      + 'reference-lines example wired to named constants. Run the '
      + 'topbar batch toggle to populate; tick chips in each plot\'s '
      + 'Compare Mode panel to select which scenarios overlay. '
      + 'Reference lines stay in sync with the project as you retune '
      + 'policy params.',
    charts: [
        scenariosPlot('sc-money', 0, 0, 6, 5,
            'Money supply (M) — overlay across scenarios', [
                S('aggregate:macro.money_supply', 'M'),
            ],
            { mode: 'overlay',
              scenarios: [...MOSLER_SCENARIOS],
              baseline: 'baseline',
              style: 'subtract' }),
        scenariosPlot('sc-prices', 6, 0, 6, 5,
            'Goods price (sector A) — overlay across scenarios', [
                S('market:goods.sector_a.good.clearing_price', 'price'),
            ],
            { mode: 'overlay',
              scenarios: [...MOSLER_SCENARIOS],
              baseline: 'baseline',
              style: 'subtract' }),
        scenariosPlot('sc-deficit', 0, 5, 6, 5,
            'Cumulative deficit — delta vs Baseline', [
                S('group:government.cumulative_deficit', 'deficit'),
            ],
            { mode: 'delta',
              scenarios: ['classic', 'mmt_dmark', 'mixed'],
              baseline: 'baseline',
              style: 'subtract' }),
        refLinesPlot('sc-corridor', 6, 5, 6, 5,
            'Interbank rate vs corridor (named-constant refs)', [
                S('market:interbank.overnight_reserves.rate',
                  'interbank rate', '#d9a14a'),
            ], [
                { value: 'central_bank.policy_rate',  label: 'Policy rate',  color: '#cccccc', lineStyle: 'dashed' },
                { value: 'central_bank.iorb',         label: 'IORB (floor)', color: '#7cb46a', lineStyle: 'dotted' },
                { value: 'central_bank.lending_rate', label: 'Lending',      color: '#d36a6a', lineStyle: 'dotted' },
            ]),
    ],
};


/** Macro / "is the economy alive" — money, prices, wages, deficit, rate. */
const ECONOMY_DASH = {
    id: ECONOMY,
    label: 'Economy overview',
    description:
        'High-level pulse of the economy: money, prices, wages, fiscal stance and the policy rate.',
    charts: [
        linePlot('econ-money', 0, 0, 6, 4, 'Money — M and reserves (M0)', [
            S('aggregate:macro.money_supply', 'M (deposits + currency)'),
            S('aggregate:macro.money_base',   'M0 (reserves)'),
        ]),
        linePlot('econ-prices', 6, 0, 6, 4, 'Goods prices by sector', [
            S('market:goods.sector_a.good.clearing_price', 'sector A'),
            S('market:goods.sector_b.good.clearing_price', 'sector B'),
        ]),

        linePlot('econ-wage', 0, 4, 6, 4, 'Mean agreed wage by sector', [
            S('market:labor.sector_a.labor.wage', 'sector A'),
            S('market:labor.sector_b.labor.wage', 'sector B'),
        ]),
        linePlot('econ-rate', 6, 4, 6, 4, 'Policy rate', [
            S('group:central_bank.policy_rate', 'policy rate'),
        ]),

        linePlot('econ-deficit', 0, 8, 12, 4, 'Government cumulative deficit', [
            S('group:government.cumulative_deficit', 'cumulative deficit'),
        ]),

        linePlot('econ-capital', 0, 12, 12, 4,
            'Firm capital stock — p10 / median / p90', [
                S('group:capitalist.capital_stock_p10',    'p10', '#5fa8d3'),
                S('group:capitalist.capital_stock_median', 'median', '#e2b93d'),
                S('group:capitalist.capital_stock_p90',    'p90', '#5fa8d3'),
            ]),
    ],
};


/** Money & Banking — the bank balance-sheet view. */
const BANKING_DASH = {
    id: BANKING,
    label: 'Money & banking',
    description:
        'Aggregate bank balance sheet, capital constraints, and the wholesale funding rate.',
    charts: [
        areaStacked('bank-assets', 0, 0, 6, 5,
            'Bank assets — composition over time', [
                S('group:banker.reserves_total',         'reserves',        '#5fa8d3'),
                S('group:banker.loans_total',            'loans',           '#d9a14a'),
                S('group:banker.bonds_total',            'govvies',         '#7cb46a'),
                S('group:banker.interbank_claims_total', 'interbank claims','#a07cb4'),
            ]),
        areaStacked('bank-liab', 6, 0, 6, 5,
            'Bank funding — composition over time', [
                S('group:banker.deposits_owed_total',        'deposits',  '#d36a6a'),
                S('group:banker.interbank_borrowings_total', 'IB borrow', '#a07cb4'),
            ]),

        linePlot('bank-cet1', 0, 5, 6, 4,
            'CET1 ratio — p10 / median / p90', [
                S('group:banker.cet1_ratio_p10',    'p10', '#5fa8d3'),
                S('group:banker.cet1_ratio_median', 'median', '#e2b93d'),
                S('group:banker.cet1_ratio_p90',    'p90', '#5fa8d3'),
            ]),
        linePlot('bank-corridor', 6, 5, 6, 4, 'Interbank rate vs corridor', [
            S('market:interbank.overnight_reserves.rate', 'interbank rate', '#d9a14a'),
            S('group:central_bank.policy_rate',           'policy rate',    '#cccccc'),
            S('group:central_bank.iorb',                  'IORB (floor)',   '#7cb46a'),
            S('group:central_bank.lending_rate',          'lending',        '#d36a6a'),
        ]),

        linePlot('bank-shortfall', 0, 9, 6, 4,
            'Reserve shortfall (CB facility usage)', [
                S('group:banker.reserve_shortfall_total', 'shortfall pre-facility'),
            ]),
        linePlot('bank-new', 6, 9, 6, 4, 'New credit issued (per tick)', [
            S('group:banker.last_new_credit_total', 'new credit'),
        ]),
    ],
};


/** Markets & prices — clearing prices and volumes. */
const MARKETS_DASH = {
    id: MARKETS,
    label: 'Markets & prices',
    description:
        'Per-market clearing prices and volumes — goods, energy, labour, bond auction and secondary.',
    charts: [
        barPlot('mk-curve-bar', 0, 0, 6, 5,
            'Bond yield curve — latest auction (by tenor)', [
                S('market:bonds_primary.bubill_6m.marginal_yield',  '6M Bubill'),
                S('market:bonds_primary.bubill_12m.marginal_yield', '12M Bubill'),
                S('market:bonds_primary.schatz_2y.marginal_yield',  '2Y Schatz'),
                S('market:bonds_primary.bobl_5y.marginal_yield',    '5Y Bobl'),
                S('market:bonds_primary.bund_10y.marginal_yield',   '10Y Bund'),
                S('market:bonds_primary.bund_30y.marginal_yield',   '30Y Bund'),
            ]),
        linePlot('mk-curve-time', 6, 0, 6, 5,
            'Bond yield curve — evolution', [
                S('market:bonds_primary.bubill_6m.marginal_yield',  '6M'),
                S('market:bonds_primary.bubill_12m.marginal_yield', '12M'),
                S('market:bonds_primary.schatz_2y.marginal_yield',  '2Y'),
                S('market:bonds_primary.bobl_5y.marginal_yield',    '5Y'),
                S('market:bonds_primary.bund_10y.marginal_yield',   '10Y'),
                S('market:bonds_primary.bund_30y.marginal_yield',   '30Y'),
            ]),

        linePlot('mk-goods-px', 0, 5, 6, 4, 'Goods clearing price', [
            S('market:goods.sector_a.good.clearing_price', 'sector A'),
            S('market:goods.sector_b.good.clearing_price', 'sector B'),
        ]),
        linePlot('mk-goods-vol', 6, 5, 6, 4, 'Goods cleared volume', [
            S('market:goods.sector_a.good.volume', 'sector A'),
            S('market:goods.sector_b.good.volume', 'sector B'),
        ]),

        linePlot('mk-energy-px', 0, 9, 6, 4, 'Energy clearing price', [
            S('market:energy.energy.clearing_price', 'energy'),
        ]),
        linePlot('mk-labor-wage', 6, 9, 6, 4, 'Labour: mean agreed wage by sector', [
            S('market:labor.sector_a.labor.wage', 'sector A'),
            S('market:labor.sector_b.labor.wage', 'sector B'),
        ]),

        linePlot('mk-sec-px', 0, 13, 12, 4, 'Secondary bond — clearing price by tenor', [
            S('market:bonds_secondary.bubill_6m.bubill_6m.clearing_price',  '6M'),
            S('market:bonds_secondary.bubill_12m.bubill_12m.clearing_price', '12M'),
            S('market:bonds_secondary.schatz_2y.schatz_2y.clearing_price',  '2Y'),
            S('market:bonds_secondary.bobl_5y.bobl_5y.clearing_price',      '5Y'),
            S('market:bonds_secondary.bund_10y.bund_10y.clearing_price',    '10Y'),
            S('market:bonds_secondary.bund_30y.bund_30y.clearing_price',    '30Y'),
        ]),
        linePlot('mk-sec-yield', 0, 17, 12, 4, 'Secondary bond — derived yield by tenor', [
            S('market:bonds_secondary.bubill_6m.bubill_6m.derived_yield',  '6M'),
            S('market:bonds_secondary.bubill_12m.bubill_12m.derived_yield', '12M'),
            S('market:bonds_secondary.schatz_2y.schatz_2y.derived_yield',  '2Y'),
            S('market:bonds_secondary.bobl_5y.bobl_5y.derived_yield',      '5Y'),
            S('market:bonds_secondary.bund_10y.bund_10y.derived_yield',    '10Y'),
            S('market:bonds_secondary.bund_30y.bund_30y.derived_yield',    '30Y'),
        ]),
    ],
};


/** Government & central bank — fiscal stance and the corridor. */
const GOVCB_DASH = {
    id: GOVCB,
    label: 'Government & central bank',
    description:
        'Treasury balance, issuance, fiscal stance, and the CB rate corridor.',
    charts: [
        linePlot('gv-tsa', 0, 0, 6, 4, 'Treasury single account (TSA)', [
            S('group:government.tsa_balance', 'TSA balance'),
        ]),
        linePlot('gv-bonds', 6, 0, 6, 4, 'Bonds outstanding (face)', [
            S('group:government.bonds_outstanding', 'outstanding'),
        ]),

        areaStacked('gv-flows', 0, 4, 6, 4,
            'Fiscal stance — spending vs taxes (stacked)', [
                S('group:government.last_spending', 'spending', '#d9a14a'),
                S('group:government.last_taxes',    'taxes',    '#7cb46a'),
            ]),
        linePlot('gv-def', 6, 4, 6, 4, 'Cumulative deficit', [
            S('group:government.cumulative_deficit', 'cumulative'),
        ]),

        linePlot('gv-corridor', 0, 8, 12, 5, 'CB rate corridor — all four rates', [
            S('group:central_bank.policy_rate',  'policy rate (centre)',  '#cccccc'),
            S('group:central_bank.iorb',         'IORB (floor)',          '#7cb46a'),
            S('group:central_bank.lending_rate', 'lending (ceiling)',     '#d36a6a'),
            S('group:central_bank.deposit_rate', 'deposit rate',          '#5fa8d3'),
        ]),

        linePlot('gv-cb-bonds', 0, 13, 6, 4, 'CB bond holdings (OMO inventory)', [
            S('group:central_bank.bonds_held', 'bonds held'),
        ]),
        linePlot('gv-cb-ib', 6, 13, 6, 4, 'CB lending facility — claims on banks', [
            S('group:central_bank.interbank_claims', 'CB lending facility'),
        ]),
    ],
};


/** Firms — production, investment and unit costs. */
const FIRMS_DASH = {
    id: FIRMS,
    label: 'Firms / real economy',
    description:
        'Firm capital, investment, expectations and unit-cost pressure.',
    charts: [
        linePlot('fm-cap', 0, 0, 6, 5,
            'Capital stock — p10 / median / p90', [
                S('group:capitalist.capital_stock_p10',    'p10',    '#5fa8d3'),
                S('group:capitalist.capital_stock_median', 'median', '#e2b93d'),
                S('group:capitalist.capital_stock_p90',    'p90',    '#5fa8d3'),
            ]),
        linePlot('fm-roi', 6, 0, 6, 5,
            'Expected ROI — p10 / median / p90', [
                S('group:capitalist.exp_roi_p10',    'p10',    '#5fa8d3'),
                S('group:capitalist.exp_roi_median', 'median', '#e2b93d'),
                S('group:capitalist.exp_roi_p90',    'p90',    '#5fa8d3'),
            ]),

        areaStacked('fm-uses', 0, 5, 6, 4,
            'Firm uses of cash — investment vs bond buys', [
                S('group:capitalist.last_investment_total', 'investment', '#5fa8d3'),
                S('group:capitalist.last_bond_buy_total',   'bond buys',  '#d9a14a'),
            ]),
        areaStacked('fm-energy', 6, 5, 6, 4,
            'Energy — cost vs bought (per tick)', [
                S('group:capitalist.last_energy_cost_total',   'energy cost',   '#d36a6a'),
                S('group:capitalist.last_energy_bought_total', 'energy bought', '#7cb46a'),
            ]),

        linePlot('fm-ask', 0, 9, 12, 4,
            'Ask price — p10 / median / p90', [
                S('group:capitalist.ask_price_p10',    'p10',    '#5fa8d3'),
                S('group:capitalist.ask_price_median', 'median', '#e2b93d'),
                S('group:capitalist.ask_price_p90',    'p90',    '#5fa8d3'),
            ]),
    ],
};


/** Ordered registry. The sidebar renders in this order — Scenarios
 *  first so a fresh user sees the compare-mode + reference-lines
 *  showcase before the bare-bones single-world dashboards. */
export const BUILTIN_DASHBOARDS = [
    SCENARIOS_DASH,
    ECONOMY_DASH,
    BANKING_DASH,
    MARKETS_DASH,
    GOVCB_DASH,
    FIRMS_DASH,
];

/** Prefix used to namespace built-in dashboard entityIds. */
export const BUILTIN_PREFIX = 'builtin:';

/** Strip the prefix and return the bare key, or null if not a built-in. */
export function parseBuiltinId(entityId) {
    if (typeof entityId !== 'string') return null;
    if (!entityId.startsWith(BUILTIN_PREFIX)) return null;
    return entityId.slice(BUILTIN_PREFIX.length);
}

/** Lookup by bare key. */
export function getBuiltinDashboard(key) {
    return BUILTIN_DASHBOARDS.find((d) => d.id === key) || null;
}
