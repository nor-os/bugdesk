/**
 * event_log_store.js — single shared subscription point for the world
 * event log.
 *
 * Multiple surfaces want the same stream now that the Bus Inspector
 * window can be open alongside (and outlive) the bottom panel:
 *   · the bottom panel's Bus snapshot needs a tick to drive the
 *     scrubber range (max tick),
 *   · each open inspector window wants the live filtered stream up to
 *     a chosen tick.
 *
 * Rather than each surface keeping its own cursor (and double-fetching
 * on every tick), this module owns one cursor + buffer, refetches on
 * demand, and notifies subscribers. Project switch / log clear calls
 * `reset()` to drop the buffer + cursor back to zero.
 *
 * Buffer size is capped by `ecoagent.eventLog.maxBufferSize` (0 means
 * unbounded). When the cap is exceeded, the oldest entries are dropped;
 * the cursor stays at the server-side total, so subsequent fetches
 * remain incremental.
 */

import { getSetting } from '../core/settings.js';

let _events = [];
let _cursor = 0;
let _inflight = null;
const _subscribers = new Set();
let _logger = { warn() {}, debug() {} };


export function setEventLogStoreLogger(logger) {
    if (logger) _logger = logger;
}

/** Current buffered events — same shape as `world_event_log` returns. */
export function getEvents() {
    return _events;
}

/** Highest tick seen in the buffer (0 when empty). */
export function maxTick() {
    let max = 0;
    for (const e of _events) {
        const t = Number(e.tick);
        if (t > max) max = t;
    }
    return max;
}

/** Subscribe to buffer updates. Returns an unsubscribe function. */
export function subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
}

/** Fetch any new entries from the bridge and notify subscribers if the
 *  buffer changed. Concurrent calls share the same in-flight promise so
 *  multiple tick handlers (bottom panel + N windows) don't stampede. */
export function fetchEvents() {
    if (_inflight) return _inflight;
    _inflight = (async () => {
        let changed = false;
        try {
            const res = await window.pywebview?.api?.world_event_log?.(_cursor);
            if (res) {
                // Server-side reset (project switch, log clear) — our
                // cursor is past the new total, so start over.
                if (Number(res.total) < _cursor) {
                    _events = [];
                    _cursor = 0;
                    changed = true;
                }
                const entries = Array.isArray(res.entries) ? res.entries : [];
                if (entries.length > 0) {
                    _events.push(...entries);
                    _cursor = Number(res.total) || (_cursor + entries.length);
                    // Cap the in-memory buffer per user setting. The
                    // cursor is the server-side total, NOT the buffer
                    // length, so dropping the head is safe: the next
                    // fetchEvents() still only pulls genuinely new
                    // entries from the bridge.
                    const cap = Math.max(0,
                        Math.floor(Number(getSetting('ecoagent.eventLog.maxBufferSize')) || 0));
                    if (cap > 0 && _events.length > cap) {
                        _events = _events.slice(_events.length - cap);
                    }
                    changed = true;
                }
            }
        } catch (err) {
            _logger.warn?.('world_event_log failed', { err });
        } finally {
            _inflight = null;
        }
        if (changed) _notify();
    })();
    return _inflight;
}

/** Drop the buffer + cursor. Used after `world_event_log_clear` or a
 *  project change. Always notifies so listeners can repaint empty. */
export function reset() {
    _events = [];
    _cursor = 0;
    _notify();
}

function _notify() {
    for (const fn of Array.from(_subscribers)) {
        try { fn(_events); }
        catch (err) { _logger.warn?.('event-log subscriber threw', { err }); }
    }
}
