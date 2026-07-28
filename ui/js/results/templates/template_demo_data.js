/**
 * template_demo_data.js
 *
 * Synthetic time-series data for dashboard template gallery previews.
 * Each profile provides enough data for widgets to render a realistic
 * mini-chart without requiring actual simulation results.
 *
 * Data structure matches the analytics format returned by the backend:
 *   Static:  varData = number[]  (plain array of values)
 *   MC:      varData = { mean: number[], p5: number[], p25: number[],
 *                        p50: number[], p75: number[], p95: number[],
 *                        min: number[], max: number[], std: number[] }
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function linspace(start, end, n) {
    const step = (end - start) / (n - 1);
    return Array.from({ length: n }, (_, i) => start + i * step);
}

function logistic(t, L, k, t0) {
    return L / (1 + Math.exp(-k * (t - t0)));
}

function overshoot(t, peak, tPeak, spread) {
    const x = (t - tPeak) / spread;
    return peak * Math.exp(-x * x / 2);
}

function addNoise(arr, amplitude) {
    // Deterministic pseudo-noise via sine mixing
    return arr.map((v, i) => v + amplitude * Math.sin(i * 7.3) * Math.sin(i * 13.1));
}

function bandFromMean(mean, factor) {
    return mean.map(v => v * factor);
}

function clampPositive(arr) {
    return arr.map(v => Math.max(0, v));
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile: generic-static
// Simple exponential/logistic curves for non-model-specific templates
// ─────────────────────────────────────────────────────────────────────────────

function buildGenericStatic() {
    const time = linspace(0, 100, 50);

    const stockA = time.map(t => logistic(t, 1000, 0.08, 50));
    const stockB = time.map(t => 500 * Math.exp(-0.02 * t) + 200);
    const flowA = time.map((t, i) => {
        const dt = i > 0 ? stockA[i] - stockA[i - 1] : 0;
        return Math.max(0, dt);
    });
    const indicator = time.map(t => 80 * Math.sin(t * 0.1) + 100 + 0.5 * t);

    return {
        time,
        stocks: {
            'stock_a': stockA,
            'stock_b': stockB,
        },
        flows: {
            'flow_a': flowA,
        },
        indicators: {
            'indicator_1': indicator,
        },
        meta: { type: 'static' },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile: generic-mc
// Generic Monte Carlo with percentile bands
// ─────────────────────────────────────────────────────────────────────────────

function buildGenericMC() {
    const time = linspace(0, 100, 50);

    const mean = time.map(t => logistic(t, 1000, 0.08, 50));

    function mcVar(meanArr) {
        return {
            mean: meanArr,
            p5: bandFromMean(meanArr, 0.6),
            p25: bandFromMean(meanArr, 0.8),
            p50: meanArr.map((v, i) => v + 10 * Math.sin(i * 0.5)),
            p75: bandFromMean(meanArr, 1.2),
            p95: bandFromMean(meanArr, 1.4),
            min: bandFromMean(meanArr, 0.4),
            max: bandFromMean(meanArr, 1.6),
            std: meanArr.map(v => v * 0.15),
        };
    }

    const mean2 = time.map(t => 500 * Math.exp(-0.02 * t) + 200);

    return {
        time,
        stocks: {
            'stock_a': mcVar(mean),
            'stock_b': mcVar(mean2),
        },
        flows: {},
        indicators: {
            'indicator_1': mcVar(time.map(t => 80 * Math.sin(t * 0.1) + 100 + 0.5 * t)),
        },
        meta: { type: 'monte-carlo', num_runs: 200 },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile: world3-static
// Realistic World3 overshoot-and-collapse curves (namespaced variable keys)
// ─────────────────────────────────────────────────────────────────────────────

function buildWorld3Static() {
    const time = linspace(1900, 2100, 50);

    // Population: S-curve growth peaking ~2040, then decline
    const pop = time.map(t => {
        const growth = logistic(t, 9e9, 0.04, 1970);
        const decline = t > 2030 ? overshoot(t, 3e9, 2070, 30) : 0;
        return Math.max(1e9, growth - decline);
    });

    // Industrial capital: exponential rise, peak ~2020, slower decline
    const ic = time.map(t => {
        const rise = 5e11 * Math.exp(0.025 * (t - 1900));
        const peak = overshoot(t, rise, 2025, 30);
        return t < 1950 ? rise * 0.2 : Math.max(2e11, peak);
    });

    // Service capital: lags industrial, peaks later
    const sc = time.map(t => {
        const rise = 2e11 * Math.exp(0.022 * (t - 1900));
        const peak = overshoot(t, rise, 2035, 35);
        return t < 1950 ? rise * 0.15 : Math.max(1e11, peak);
    });

    // Industrial output per capita
    const io = time.map((t, i) => ic[i] / 3);
    const iopc = time.map((_, i) => io[i] / pop[i]);

    // Service output per capita
    const sopc = time.map((_, i) => sc[i] / pop[i]);

    // Food per capita: rises then falls after pollution/land degradation
    const fpc = time.map(t => {
        const base = logistic(t, 800, 0.05, 1960);
        const decline = t > 2020 ? (t - 2020) * 3 : 0;
        return Math.max(100, base - decline);
    });

    // Arable land: slow expansion then erosion-driven decline
    const al = time.map(t => {
        const expansion = logistic(t, 3.2e9, 0.03, 1960);
        const erosion = t > 1990 ? (t - 1990) * 5e6 : 0;
        return Math.max(1e9, expansion - erosion);
    });

    // Potentially arable land: monotonic decline
    const pal = time.map(t => {
        const loss = logistic(t, 3.5e9, 0.025, 1980);
        return Math.max(1e8, 4e9 - loss);
    });

    // Land fertility: stable then declining from pollution
    const lfert = time.map(t => {
        const base = 600;
        const decline = t > 2000 ? (t - 2000) * 2.5 : 0;
        return Math.max(100, base - decline);
    });

    // Non-renewable resources: monotonic depletion
    const nr = time.map(t => {
        const depletion = logistic(t, 9.5e11, 0.035, 2010);
        return Math.max(5e10, 1e12 - depletion);
    });

    // Resource fraction remaining
    const nrfr = nr.map(v => v / 1e12);

    // Fraction of capital allocated to resources: rises as resources deplete
    const resFcaor = nrfr.map(f => Math.min(1, 0.05 / Math.max(0.01, f)));

    // Pollution: slow rise, exponential mid-century, eventual decline
    const ppol = time.map(t => {
        const rise = overshoot(t, 8e8, 2040, 35);
        const base = 2.5e7;
        return base + Math.max(0, rise);
    });

    // Pollution index (ratio to 1970 level)
    const ppol1970 = 2.5e7 + overshoot(1970, 8e8, 2040, 35);
    const ppolxOut = ppol.map(v => v / ppol1970);

    // Births and deaths flows
    const births = time.map((t, i) => pop[i] * (0.035 - 0.0001 * (t - 1900)));
    const deaths = time.map((t, i) => {
        const baseRate = 0.015 + (t > 2040 ? 0.0003 * (t - 2040) : 0);
        return pop[i] * baseRate;
    });

    return {
        time,
        stocks: {
            'Population.population': pop,
            'Capital.industrial_capital': ic,
            'Capital.service_capital': sc,
            'Agriculture.arable_land': al,
            'Agriculture.potential_arable_land': pal,
            'Agriculture.land_fertility': lfert,
            'Resources.nonrenewable_resources': nr,
            'Pollution.persistent_pollution': ppol,
        },
        flows: {
            'Population.birth_rate': births,
            'Population.deaths': clampPositive(deaths),
        },
        indicators: {
            'Capital.ind_output_pc': iopc,
            'Capital.serv_output_pc': sopc,
            'Agriculture.food_per_capita': fpc,
            'Pollution.pollution_index': ppolxOut,
            'Resources.resource_fraction': nrfr,
            'Resources.res_capital_cost': resFcaor,
        },
        meta: { type: 'static' },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile: world3-mc
// World3 Monte Carlo with percentile bands (namespaced variable keys)
// ─────────────────────────────────────────────────────────────────────────────

function buildWorld3MC() {
    const base = buildWorld3Static();

    function toMC(arr, spreadFactor = 0.15) {
        const mean = arr;
        const spread = mean.map(v => Math.abs(v) * spreadFactor);
        return {
            mean,
            p5:  mean.map((v, i) => v - 1.65 * spread[i]),
            p25: mean.map((v, i) => v - 0.67 * spread[i]),
            p50: addNoise(mean, mean[Math.floor(mean.length / 2)] * 0.02),
            p75: mean.map((v, i) => v + 0.67 * spread[i]),
            p95: mean.map((v, i) => v + 1.65 * spread[i]),
            min: mean.map((v, i) => v - 2.5 * spread[i]),
            max: mean.map((v, i) => v + 2.5 * spread[i]),
            std: spread,
        };
    }

    return {
        time: base.time,
        stocks: {
            'Population.population': toMC(base.stocks['Population.population']),
            'Capital.industrial_capital':     toMC(base.stocks['Capital.industrial_capital'], 0.2),
            'Capital.service_capital':     toMC(base.stocks['Capital.service_capital'], 0.2),
            'Agriculture.arable_land': toMC(base.stocks['Agriculture.arable_land']),
            'Agriculture.potential_arable_land': toMC(base.stocks['Agriculture.potential_arable_land']),
            'Agriculture.land_fertility': toMC(base.stocks['Agriculture.land_fertility']),
            'Resources.nonrenewable_resources':   toMC(base.stocks['Resources.nonrenewable_resources']),
            'Pollution.persistent_pollution': toMC(base.stocks['Pollution.persistent_pollution'], 0.25),
        },
        flows: {},
        indicators: {
            'Capital.ind_output_pc':        toMC(base.indicators['Capital.ind_output_pc'], 0.2),
            'Capital.serv_output_pc':        toMC(base.indicators['Capital.serv_output_pc'], 0.2),
            'Agriculture.food_per_capita':     toMC(base.indicators['Agriculture.food_per_capita']),
            'Pollution.pollution_index': toMC(base.indicators['Pollution.pollution_index'], 0.25),
            'Resources.resource_fraction':      toMC(base.indicators['Resources.resource_fraction']),
            'Resources.res_capital_cost': toMC(base.indicators['Resources.res_capital_cost'], 0.3),
        },
        meta: { type: 'monte-carlo', num_runs: 500 },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile registry — built lazily on first access
// ─────────────────────────────────────────────────────────────────────────────

const builders = {
    'generic-static': buildGenericStatic,
    'generic-mc':     buildGenericMC,
    'world3-static':  buildWorld3Static,
    'world3-mc':      buildWorld3MC,
};

const cache = new Map();

/**
 * Get demo data for a profile.
 * @param {string} profileId - Profile key (e.g., 'world3-static')
 * @returns {Object|null} Analytics-shaped data or null
 */
export function getDemoData(profileId) {
    if (cache.has(profileId)) return cache.get(profileId);

    const builder = builders[profileId];
    if (!builder) return null;

    const data = builder();
    cache.set(profileId, data);
    return data;
}

/**
 * Get all available demo data profile IDs.
 * @returns {string[]}
 */
export function getDemoDataProfiles() {
    return Object.keys(builders);
}
