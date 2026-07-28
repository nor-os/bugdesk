/**
 * WebSocket streaming client.
 *
 * The single live transport for run/batch progress: the Python bridge
 * broadcasts `{event, payload}` frames (MSG_RUN_EVENT) over the WebSocket
 * instead of pywebview `evaluate_js`. This client re-dispatches each frame
 * to `window.__ecoagentPush(event, payload)` — the same contract the rest
 * of the UI already consumes (runtime_controls → `ecoagent:*` bus events,
 * the dashboard's incremental refresh, the batch progress tracker). So the
 * wire is all that changed; downstream JS is untouched. Works in both the
 * pywebview webview and a plain browser tab.
 */

// Binary frame header byte. Must match ecoagent/streaming/server.py.
const MSG_RUN_EVENT = 20;

export class StreamingClient {
    constructor(options = {}) {
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 23988;
        this.reconnectDelay = options.reconnectDelay || 2000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;

        this.ws = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.connected = false;
        this.intentionalClose = false;

        this.eventBus = options.eventBus || null;
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[StreamingClient] Already connected');
            return;
        }

        this.intentionalClose = false;
        const url = `ws://${this.host}:${this.port}`;
        console.log('[StreamingClient] Attempting connection to', url);

        try {
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                console.log('[StreamingClient] ✓ Connected to', url);
                this.connected = true;
                this.reconnectAttempts = 0;
                this.eventBus?.emit('streaming:connected', { url });
            };

            this.ws.onclose = (event) => {
                console.log('[StreamingClient] ✗ Disconnected:', event.code, event.reason);
                this.connected = false;
                this.eventBus?.emit('streaming:disconnected', { code: event.code, reason: event.reason });
                if (!this.intentionalClose) {
                    this._scheduleReconnect();
                }
            };

            this.ws.onerror = () => {
                // Only log on first attempt to avoid console spam
                if (this.reconnectAttempts === 0) {
                    console.warn('[StreamingClient] WebSocket connection failed - Python backend may not be running');
                }
            };

            this.ws.onmessage = (event) => {
                this._handleMessage(event.data);
            };
        } catch (err) {
            console.error('[StreamingClient] ✗ Failed to connect:', err);
            this._scheduleReconnect();
        }
    }

    disconnect() {
        this.intentionalClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('[StreamingClient] Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
        if (this.reconnectAttempts <= 2) {
            console.log(`[StreamingClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        }
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    _handleMessage(data) {
        try {
            // Binary frame: byte 0 = message type, rest = JSON payload.
            const buffer = new Uint8Array(data);
            const msgType = buffer[0];
            const jsonStr = new TextDecoder().decode(buffer.slice(1));
            const payload = JSON.parse(jsonStr);
            if (msgType === MSG_RUN_EVENT) {
                this._handleRunEvent(payload);
            } else {
                console.warn('[StreamingClient] Unknown message type:', msgType);
            }
        } catch (err) {
            console.error('[StreamingClient] Failed to parse message:', err);
        }
    }

    /**
     * Live WorldModel run/batch event → re-dispatch to the existing
     * `window.__ecoagentPush(event, payload)` contract so runtime_controls,
     * the dashboard, and the batch progress tracker react unchanged.
     */
    _handleRunEvent(msg) {
        const event = msg?.event;
        if (!event) return;
        const payload = msg.payload || {};
        try {
            window.__ecoagentPush?.(event, payload);
        } catch (err) {
            console.error('[StreamingClient] run-event dispatch failed:', event, err);
        }
    }

    isConnected() {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }
}

// Singleton instance
let _streamingClient = null;

/** Get or create the global streaming client. */
export function getStreamingClient(options = {}) {
    if (!_streamingClient) {
        _streamingClient = new StreamingClient(options);
    }
    return _streamingClient;
}

export default StreamingClient;
