/**
 * comparison_data_cache.js
 *
 * Lightweight cache for loading and storing analytics data from multiple
 * scenarios. Used by the dashboard's scenario comparison overlay feature.
 */

export class ComparisonDataCache {
    /**
     * @param {Object} options
     * @param {Object} options.hostBridge - pywebview bridge API
     * @param {Object} options.eventBus - EventBus instance
     */
    constructor({ hostBridge, eventBus }) {
        this._hostBridge = hostBridge;
        this._eventBus = eventBus;
        /** @type {Map<string, { analytics: Object, timestamp: number }>} */
        this._cache = new Map();

        // Invalidate cache when a scenario gets new results
        if (eventBus) {
            eventBus.on('dataset:updated', (payload) => {
                if (payload?.scenarioId) {
                    this.invalidate(payload.scenarioId);
                }
            });
        }
    }

    /**
     * Load analytics for a scenario (with caching).
     * @param {string} scenarioId
     * @param {string} [runId] - Specific run ID, or omit for latest
     * @returns {Promise<Object|null>} Analytics data object or null on failure
     */
    async getAnalytics(scenarioId, runId) {
        const cacheKey = runId ? `${scenarioId}:${runId}` : scenarioId;

        if (this._cache.has(cacheKey)) {
            return this._cache.get(cacheKey).analytics;
        }

        try {
            const params = { scenarioId };
            if (runId) params.runId = runId;

            const response = await this._hostBridge.sim_get_scenario_result(params);
            if (!response || response.error) return null;

            const analytics = response.analytics || response;
            this._cache.set(cacheKey, {
                analytics,
                timestamp: Date.now(),
            });

            return analytics;
        } catch (err) {
            console.warn(`[ComparisonDataCache] Failed to load scenario ${scenarioId}:`, err);
            return null;
        }
    }

    /**
     * Invalidate cache for a scenario.
     * @param {string} scenarioId
     */
    invalidate(scenarioId) {
        for (const key of this._cache.keys()) {
            if (key === scenarioId || key.startsWith(`${scenarioId}:`)) {
                this._cache.delete(key);
            }
        }
    }

    /**
     * Clear entire cache.
     */
    clear() {
        this._cache.clear();
    }
}

export default ComparisonDataCache;
