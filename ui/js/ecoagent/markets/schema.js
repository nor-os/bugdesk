/**
 * schema.js — per-kind rule schemas + display vocabulary, shared by
 * the market detail tab and the archetype tab.
 *
 * Originally lived inline in `market_tab.js`. Extracted in Phase M2 of
 * the markets UX plan (see docs/MARKETS_UX_PLAN.md) so the archetype
 * editor can render the same "Template rules" form using the exact
 * same schema. Stays the single source of truth — when a new market
 * kind lands, only this file changes.
 *
 * Schema shape — each field is one of:
 *   { name, label, type: 'number',  step?, default?, placeholder?, help? }
 *   { name, label, type: 'text',    placeholder?, help?, default? }
 *   { name, label, type: 'select',  options: [{value, label}], default?, help? }
 *   { name, label, type: 'ref',     refKind, refQuery, dependsOn?, help? }
 *
 * The 'ref' type integrates with markets/refs.js — refQuery(values,
 * ctx) returns the option list, dependsOn lists fields that, when
 * changed, must re-render this one so the option set matches the new
 * parent value.
 */

import {
    refCurrencies,
    refAssets,
    refUnderlying,
    refSpotMarkets,
} from './refs.js';

export const KIND_LABEL = {
    ContinuousDoubleAuction: 'Continuous double auction',
    SearchAndMatching:       'Search and matching (labor)',
    BondAuction:             'Bond auction (primary)',
    BondSecondary:           'Bond secondary (CDA)',
    Interbank:               'Interbank credit',
    MeritOrder:              'Merit-order dispatch (energy)',
    FX:                      'FX (CDA over foreign currency)',
    Commodity:               'Commodity (CDA over real assets)',
    Futures:                 'Futures (cash-settled contracts)',
    Equity:                  'Equity (stock trading)',
    Housing:                 'Housing (real estate)',
    Rental:                  'Rental (housing rental match)',
};

export const IMPLEMENTED_KINDS = new Set(Object.keys(KIND_LABEL));
export const ALL_KINDS = Object.keys(KIND_LABEL);

export function kindOptionLabel(k) {
    return IMPLEMENTED_KINDS.has(k) ? KIND_LABEL[k] : `${KIND_LABEL[k]} — coming soon`;
}

// Per-kind rule schemas — keep aligned with ecoagent/sim/markets/*.py.
export const RULES_SCHEMA = {
    ContinuousDoubleAuction: [],
    SearchAndMatching: [
        { name: 'A',     label: 'Match-rate scale (A)',  type: 'number', step: '0.01', default: 0.5,
          help: 'Cobb-Douglas: meetings = floor(A · U^α · V^(1-α)). Higher A ⇒ more pairings; A=0 ⇒ no matches.' },
        { name: 'alpha', label: 'Worker elasticity (α)', type: 'number', step: '0.01', default: 0.5,
          help: 'Weight on job-seekers (U) vs vacancies (V) in the matching function. Range [0, 1].' },
    ],
    BondAuction: [
        { name: 'mechanism', label: 'Mechanism', type: 'select',
          options: [
              { value: 'discriminatory', label: 'discriminatory (pay-as-bid)' },
              { value: 'uniform',        label: 'uniform-price (single clearing)' },
          ],
          default: 'discriminatory',
          help: 'Discriminatory: each winning bidder pays their own bid. Uniform: all pay the lowest accepted bid. Face value, tenor, and instrument are bond-template properties — set them on the Government archetype.' },
    ],
    BondSecondary: [],
    Interbank: [
        { name: 'tenor_ticks',          label: 'Tenor (ticks)',         type: 'number', step: '1',      default: 1,
          help: 'How many ticks each interbank loan runs before settlement.' },
        { name: 'lending_rate_ceiling', label: 'Lending-rate ceiling',  type: 'number', step: '0.0001', default: 0.05,
          help: 'Marginal-lending-facility rate; lender of last resort. Matched rates clip at this ceiling.' },
        { name: 'deposit_rate_floor',   label: 'Deposit-rate floor',    type: 'number', step: '0.0001', default: 0.00,
          help: 'Deposit-facility rate; reserves outside the corridor earn this floor. Rates clip ≥ this.' },
    ],
    MeritOrder: [
        { name: 'price_cap', label: 'Price cap', type: 'number', step: 'any',
          placeholder: 'no cap',
          help: 'Optional regulator cap on the marginal clearing price. Generators above the cap still dispatch but every fill pays the cap, not their marginal cost. Leave blank for uncapped.' },
    ],
    FX: [
        { name: 'base_currency', label: 'Base currency', type: 'ref',
          refKind: 'currency', refQuery: refCurrencies,
          help: 'The currency on the numerator of the rate. One unit of base costs <rate> units of quote.' },
        { name: 'quote_currency', label: 'Quote currency', type: 'ref',
          refKind: 'currency', refQuery: refCurrencies,
          help: 'The currency on the denominator of the rate. Settlement pays the seller this many units of quote per unit of base.' },
    ],
    Commodity: [
        { name: 'asset_kind', label: 'Asset kind', type: 'ref',
          refKind: 'asset_kind', refQuery: refAssets,
          help: 'Which non-financial asset kind trades on this market. Must match an asset_kind id declared in project.json.' },
        { name: 'inventory_label', label: 'Inventory account label', type: 'text',
          default: 'Inventory',
          help: 'Label used for the seller-side inventory account on the ledger.' },
    ],
    Futures: [
        { name: 'underlying_kind', label: 'Underlying kind', type: 'select',
          options: [
              { value: 'fx',        label: 'fx' },
              { value: 'commodity', label: 'commodity' },
              { value: 'equity',    label: 'equity' },
          ], default: 'fx',
          help: 'Which spot-market family the underlying lives in. Determines how mid is sourced.' },
        { name: 'underlying', label: 'Underlying', type: 'ref',
          refKind: 'underlying', refQuery: refUnderlying,
          dependsOn: ['underlying_kind'],
          help: 'Symbol of the underlying spot (e.g. "USD" for an FX future, "oil" for a commodity future).' },
        { name: 'tenor_ticks', label: 'Tenor (ticks)', type: 'number', step: '1', default: 30,
          help: 'How many ticks each contract runs before cash settlement at the prevailing spot mid.' },
        { name: 'spot_market_id', label: 'Spot market', type: 'ref',
          refKind: 'market', refQuery: refSpotMarkets,
          dependsOn: ['underlying_kind'],
          help: 'Optional override — the market whose mid drives mark-to-market. Leave blank to let the engine resolve from `underlying`.' },
    ],
    Equity: [],
    Housing: [],
    Rental: [
        { name: 'A',     label: 'Match-rate scale (A)',  type: 'number', step: '0.01', default: 0.5,
          help: 'Cobb-Douglas: meetings = A · units^α · seekers^(1-α). Higher A ⇒ more pairings; A=0 ⇒ no matches.' },
        { name: 'alpha', label: 'Unit elasticity (α)',   type: 'number', step: '0.01', default: 0.5,
          help: 'Weight on vacant units vs prospective tenants in the matching function. Range [0, 1].' },
    ],
};
