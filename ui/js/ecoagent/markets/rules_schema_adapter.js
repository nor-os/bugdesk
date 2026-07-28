/**
 * rules_schema_adapter.js — bridge between the registry-stored
 * AttributeSpec rules_schema (T4.3) and the existing per-field
 * renderer in market_tab.js / market_archetype_tab.js.
 *
 * The registry stores each rule field as an AttributeSpec:
 *
 *   { name, type, default?, value?, description?, options?,
 *     min?, max?, step?, unit?, required? }
 *
 * The existing rules-form renderer expects:
 *
 *   { name, label, type, default?, help?, options?, step?,
 *     placeholder?, refKind?, refQuery?, dependsOn? }
 *
 * `attrSpecToField` converts one entry; `attrSpecsToFields` does the
 * list. `ref:<kind>` types are mapped onto the existing renderer's
 * `ref` type plus the matching refQuery from refs.js — so the
 * dropdown population path is unchanged.
 */

import {
    refCurrencies,
    refAssets,
    refRealAssets,
    refSpotMarkets,
} from './refs.js';

// Map AttributeSpec ref-target → the refQuery the existing renderer
// already wires for that kind. Add a new entry here when a new
// rules_schema entry references a new kind.
const REF_QUERIES = {
    currency:    { refKind: 'currency',   refQuery: refCurrencies },
    asset_kind:  { refKind: 'asset_kind', refQuery: refRealAssets },
    market:      { refKind: 'market',     refQuery: refSpotMarkets },
};


/** Capitalise the first letter of an identifier for use as a label
 *  fallback when the spec doesn't carry one. Identifiers use
 *  snake_case; convert to "Snake case" for readability. */
function _humanise(name) {
    const s = String(name || '').replace(/_/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : '';
}


export function attrSpecToField(spec) {
    if (!spec || typeof spec !== 'object') return null;
    const name = String(spec.name || '').trim();
    if (!name) return null;
    const type = String(spec.type || 'string');
    const out = {
        name,
        label: _humanise(name),
        default: spec.default,
        help: spec.description || '',
    };
    if (spec.step !== undefined && spec.step !== null) out.step = String(spec.step);
    if (spec.min !== undefined && spec.min !== null) out.min = spec.min;
    if (spec.max !== undefined && spec.max !== null) out.max = spec.max;

    // Ref types — map onto the existing renderer's `ref` shape so the
    // refQuery + stale-detection paths keep working.
    if (type.startsWith('ref:')) {
        const target = type.slice(4);
        const ref = REF_QUERIES[target];
        out.type = 'ref';
        out.refKind  = (ref?.refKind) || target;
        out.refQuery = (ref?.refQuery) || (() => []);
        return out;
    }

    // Select — string type with options[] becomes the existing
    // renderer's `select`. Plain string options are wrapped as
    // {value, label} since the renderer reads option.label.
    if (Array.isArray(spec.options) && spec.options.length > 0) {
        out.type = 'select';
        out.options = spec.options.map((o) => {
            if (typeof o === 'string') return { value: o, label: o };
            if (o && typeof o === 'object') {
                return { value: o.value ?? o.id ?? '', label: o.label ?? o.value ?? '' };
            }
            return { value: String(o), label: String(o) };
        });
        return out;
    }

    // Scalars.
    if (type === 'number' || type === 'integer') {
        out.type = 'number';
        if (type === 'integer' && out.step === undefined) out.step = '1';
        return out;
    }
    if (type === 'boolean') {
        out.type = 'select';
        out.options = [
            { value: 'true',  label: 'true' },
            { value: 'false', label: 'false' },
        ];
        return out;
    }
    // string + expression + anything else → text input.
    out.type = 'text';
    return out;
}


export function attrSpecsToFields(specs) {
    return (Array.isArray(specs) ? specs : [])
        .map(attrSpecToField)
        .filter(Boolean);
}
