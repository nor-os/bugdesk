/**
 * refs.js — typed-reference resolvers for the market rules form.
 *
 * Phase M1 of the markets UX plan (see docs/MARKETS_UX_PLAN.md). The
 * market rules form historically accepted free-form strings for
 * inter-market references (futures→spot, FX currency pairs, commodity
 * asset_kind). A typo there silently broke mark-to-market at runtime
 * with no UI feedback. This module:
 *
 *   1. Loads the project's "vocabulary" (currencies, asset kinds,
 *      markets, archetypes) in one network round-trip per tab open.
 *   2. Exposes a small set of `refQuery` functions that, given the
 *      current rules values + the vocabulary, return the valid
 *      options for a dependent dropdown.
 *
 * Each ref field in the rules schema declares a `refKind` and a
 * `refQuery(values, ctx) → [{value, label}]`. The field renderer in
 * `market_tab.js` uses the result to populate the dropdown.
 *
 * Conventions:
 *   - ctx is the object returned by loadRefContext(); each consumer
 *     gets the same instance, so caching at the tab level is enough.
 *   - refQuery never throws — empty list is fine; "no options" is a
 *     valid UI state.
 *   - Stale references (a stored value not in the current options)
 *     are detected by the caller comparing the form value to the
 *     options array — refs.js only produces the option set.
 */


/** Map from Futures.underlying_kind → the spot market kind that holds
 *  the actual price. Used to filter the spot-market picker. */
export const SPOT_MARKET_KIND_FOR_UNDERLYING = {
    fx:        'FX',
    commodity: 'Commodity',
    equity:    'Equity',
};


/** Load every vocabulary the market rules form needs in parallel.
 *  Returns a context object the refQuery functions consume. */
export async function loadRefContext(api) {
    if (!api) return _emptyContext();
    const [currencies, assetKinds, markets] = await Promise.all([
        _safeCall(api.currencies_list),
        _safeCall(api.assets_list),
        _safeCall(api.market_instances_list),
    ]);
    return {
        currencies: Array.isArray(currencies) ? currencies : [],
        assetKinds: Array.isArray(assetKinds) ? assetKinds : [],
        markets:    Array.isArray(markets)    ? markets    : [],
    };
}


/* ── refQuery functions for each ref kind ─────────────────────────── */

/** Options: every declared currency. Used by FX base/quote pickers. */
export function refCurrencies(_values, ctx) {
    return (ctx?.currencies || []).map((c) => ({
        value: c.id,
        label: c.symbol ? `${c.id} (${c.symbol})` : c.id,
    }));
}


/** Options: every declared asset kind (real or financial). Used by
 *  Commodity.asset_kind. */
export function refAssets(_values, ctx) {
    return (ctx?.assetKinds || []).map((k) => ({
        value: k.id,
        label: k.currency ? `${k.id} · ${k.currency}` : k.id,
    }));
}


/** Options: real asset kinds only — for markets that explicitly
 *  trade non-financial assets (e.g. Commodity excludes bond / equity
 *  kinds). Currently equivalent to refAssets; kept separate so we
 *  can tighten the filter later without re-touching the schemas. */
export function refRealAssets(_values, ctx) {
    return (ctx?.assetKinds || [])
        .filter((k) => k.is_financial === false)
        .map((k) => ({
            value: k.id,
            label: k.id,
        }));
}


/** Options: every market whose kind matches the family implied by
 *  `values.underlying_kind`. Used by Futures.spot_market_id. */
export function refSpotMarkets(values, ctx) {
    const targetKind = SPOT_MARKET_KIND_FOR_UNDERLYING[String(values?.underlying_kind || 'fx')];
    if (!targetKind) return [];
    return (ctx?.markets || [])
        .filter((m) => m.kind_id === targetKind)
        .map((m) => ({
            value: m.id,
            label: m.id,
        }));
}


/** Options: the underlying symbol for a Futures contract. The
 *  appropriate vocabulary depends on `values.underlying_kind`:
 *    - fx        → currencies (the BASE leg of the FX pair)
 *    - commodity → asset kinds
 *    - equity    → firm ids (= equity-market-trading firms; surfaced
 *                  as per-firm books, see Gap C). For now we list any
 *                  equity market id; once Gap C lands we'll narrow to
 *                  per-firm sub-references.
 */
export function refUnderlying(values, ctx) {
    const kind = String(values?.underlying_kind || 'fx');
    if (kind === 'fx') return refCurrencies(values, ctx);
    if (kind === 'commodity') return refAssets(values, ctx);
    if (kind === 'equity') {
        return (ctx?.markets || [])
            .filter((m) => m.kind_id === 'Equity')
            .map((m) => ({ value: m.id, label: m.id }));
    }
    return [];
}


/* ── helpers ──────────────────────────────────────────────────────── */

function _emptyContext() {
    return { currencies: [], assetKinds: [], markets: [] };
}

async function _safeCall(fn) {
    if (typeof fn !== 'function') return [];
    try { return await fn(); }
    catch { return []; }
}
