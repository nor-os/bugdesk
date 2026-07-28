/**
 * DataHubService
 * --------------
 * Centralized gateway for dataset/series operations so UI surfaces do not talk to the
 * host bridge directly. The service enforces required host methods, caches dataset lists,
 * and emits events for downstream consumers (data page, nodes, dashboards, etc.).
 */

const REQUIRED_HOST_METHODS = Object.freeze([
    'list_repo',
    'get_series_by_id',
    'csv_preview',
    'refine_preview',
    'save_series',
]);

function validateHostBridge(hostBridge) {
    if (!hostBridge || typeof hostBridge !== 'object') {
        return { ok: false, missing: [...REQUIRED_HOST_METHODS] };
    }
    const missing = REQUIRED_HOST_METHODS.filter((method) => typeof hostBridge[method] !== 'function');
    return { ok: missing.length === 0, missing };
}

const HUB_EVENTS = Object.freeze({
    HOST_ATTACHED: 'data:hub:host-attached',
    HOST_DETACHED: 'data:hub:host-detached',
    DATASETS_UPDATED: 'data:datasets:updated',
    SERIES_FETCHED: 'data:series:fetched',
    IMPORT_PREVIEW_READY: 'data:import:preview-ready',
    IMPORT_REFINE_READY: 'data:import:refine-ready',
    IMPORT_SAVED: 'data:import:saved',
});

// Cache TTL for series data (milliseconds)
const SERIES_CACHE_TTL = 3000;

export class DataHubService {
    constructor({ eventBus = null, logger = null, hostBridge = null } = {}) {
        this.eventBus = eventBus;
        this.logger = logger;
        this.hostBridge = null;
        this.datasetCache = [];
        this.datasetFetchedAt = null;

        // In-flight request deduplication: Map<cacheKey, Promise>
        this._seriesInFlight = new Map();
        // Short-lived series cache: Map<cacheKey, { data, fetchedAt }>
        this._seriesCache = new Map();

        if (hostBridge) {
            // Try to set host bridge, but don't throw during construction
            // The bridge may be attached later when pywebviewready fires
            try {
                this.setHostBridge(hostBridge);
            } catch (error) {
                this.logger?.warn?.('data-hub', 'Host bridge not ready during construction, will attach later', {
                    error: error.message,
                });
            }
        }
    }

    setHostBridge(hostBridge) {
        if (hostBridge === this.hostBridge) {
            return;
        }
        if (hostBridge === null) {
            this.hostBridge = null;
            this.eventBus?.emit?.(HUB_EVENTS.HOST_DETACHED, { timestamp: Date.now() });
            return;
        }
        if (typeof hostBridge !== 'object') {
            throw new Error('DataHubService.setHostBridge expects an object or null');
        }
        const validation = validateHostBridge(hostBridge);
        if (!validation.ok) {
            const missing = validation.missing?.[0] || 'unknown';
            throw new Error(`Data hub host bridge missing method ${missing}()`);
        }
        this.hostBridge = hostBridge;
        this.logger?.info?.('data-hub', 'Host bridge attached to DataHubService');
        this.eventBus?.emit?.(HUB_EVENTS.HOST_ATTACHED, { timestamp: Date.now() });
    }

    hasHostBridge() {
        return Boolean(this.hostBridge);
    }

    async listDatasets({ force = false } = {}) {
        if (!force && this.datasetCache.length) {
            return {
                ok: true,
                datasets: this.datasetCache.slice(),
                cached: true,
                fetchedAt: this.datasetFetchedAt,
            };
        }
        const response = await this.#callHost('list_repo');
        const datasets = Array.isArray(response?.datasets) ? response.datasets : [];
        this.datasetCache = datasets;
        this.datasetFetchedAt = Date.now();
        this.eventBus?.emit?.(HUB_EVENTS.DATASETS_UPDATED, {
            count: datasets.length,
            fetchedAt: this.datasetFetchedAt,
        });
        return {
            ...response,
            datasets,
            cached: false,
            fetchedAt: this.datasetFetchedAt,
        };
    }

    getCachedDatasets() {
        return this.datasetCache.slice();
    }

    /**
     * Clear the series cache. Call this when data changes (e.g., after simulation run).
     * @param {string} [seriesId] - Optional: clear only entries for this series
     */
    clearSeriesCache(seriesId = null) {
        if (seriesId) {
            // Clear entries matching this seriesId
            for (const key of this._seriesCache.keys()) {
                if (key.startsWith(seriesId)) {
                    this._seriesCache.delete(key);
                }
            }
        } else {
            this._seriesCache.clear();
        }
    }

    async fetchSeriesById(seriesId, options = {}) {
        if (!seriesId) {
            throw new Error('fetchSeriesById requires a seriesId');
        }

        // Create cache key from seriesId + options
        const cacheKey = this.#makeSeriesCacheKey(seriesId, options);

        // Check short-lived cache first
        const cached = this._seriesCache.get(cacheKey);
        if (cached && (Date.now() - cached.fetchedAt) < SERIES_CACHE_TTL) {
            this.logger?.debug?.('data-hub', `Series cache hit: ${seriesId.slice(0, 8)}...`);
            return cached.data;
        }

        // Check if there's already an in-flight request for this exact query
        if (this._seriesInFlight.has(cacheKey)) {
            this.logger?.debug?.('data-hub', `Deduplicating in-flight request: ${seriesId.slice(0, 8)}...`);
            return this._seriesInFlight.get(cacheKey);
        }

        // Create the request promise
        const requestPromise = this.#doFetchSeriesById(seriesId, options, cacheKey);

        // Store in-flight promise for deduplication
        this._seriesInFlight.set(cacheKey, requestPromise);

        try {
            const response = await requestPromise;
            return response;
        } finally {
            // Remove from in-flight map when done
            this._seriesInFlight.delete(cacheKey);
        }
    }

    #makeSeriesCacheKey(seriesId, options) {
        // Create a stable key from seriesId and relevant options
        const optStr = JSON.stringify({
            limit: options.limit ?? null,
            offset: options.offset ?? null,
            downsample: options.downsample ?? true,
            target_points: options.target_points ?? null,
            t_start: options.t_start ?? null,
            t_end: options.t_end ?? null,
        });
        return `${seriesId}::${optStr}`;
    }

    async #doFetchSeriesById(seriesId, options, cacheKey) {
        const payload = {
            series_id: seriesId,
            ...(options || {}),
        };
        console.log('[DataHub] Calling get_series_by_id with payload:', payload);
        const response = await this.#callHost('get_series_by_id', payload);
        console.log('[DataHub] get_series_by_id response:', response?.ok, response?.error, 'rows:', response?.rows?.length);

        // Cache successful responses
        if (response?.ok) {
            this._seriesCache.set(cacheKey, {
                data: response,
                fetchedAt: Date.now(),
            });

            // Prune old cache entries (keep max 50)
            if (this._seriesCache.size > 50) {
                const oldest = [...this._seriesCache.entries()]
                    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
                    .slice(0, this._seriesCache.size - 50);
                oldest.forEach(([key]) => this._seriesCache.delete(key));
            }
        }

        this.eventBus?.emit?.(HUB_EVENTS.SERIES_FETCHED, {
            seriesId,
            ok: Boolean(response?.ok),
            rowCount: Array.isArray(response?.rows) ? response.rows.length : 0,
        });
        return response;
    }

    async requestCsvPreview(payload) {
        const response = await this.#callHost('csv_preview', payload);
        this.eventBus?.emit?.(HUB_EVENTS.IMPORT_PREVIEW_READY, {
            columns: Array.isArray(response?.headers) ? response.headers.length : 0,
            rows: Array.isArray(response?.rows) ? response.rows.length : 0,
        });
        return response;
    }

    async requestRefinePreview(payload) {
        const response = await this.#callHost('refine_preview', payload);
        this.eventBus?.emit?.(HUB_EVENTS.IMPORT_REFINE_READY, {
            columns: Array.isArray(response?.headers) ? response.headers.length : 0,
            rows: Array.isArray(response?.rows) ? response.rows.length : 0,
        });
        return response;
    }

    async saveSeries(payload) {
        const response = await this.#callHost('save_series', payload);
        if (response?.ok) {
            this.eventBus?.emit?.(HUB_EVENTS.IMPORT_SAVED, {
                datasetId: response.datasetId ?? payload?.save?.datasetId ?? null,
                seriesId: response.seriesId ?? null,
            });
        }
        return response;
    }

    async #callHost(method, payload = undefined) {
        if (!this.hostBridge || typeof this.hostBridge[method] !== 'function') {
            throw new Error(`Data hub host bridge not ready for ${method}`);
        }
        try {
            const result = payload === undefined
                ? await this.hostBridge[method]()
                : await this.hostBridge[method](payload);
            return result;
        } catch (error) {
            this.logger?.error?.('data-hub', `Host call failed: ${method}`, { error });
            throw error;
        }
    }
}

DataHubService.EVENTS = HUB_EVENTS;
DataHubService.REQUIRED_HOST_METHODS = REQUIRED_HOST_METHODS;
DataHubService.validateHostBridge = validateHostBridge;
export { validateHostBridge as validateDataHubHostBridge };
