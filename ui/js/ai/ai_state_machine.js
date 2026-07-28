/**
 * AI Chat state machine.
 *
 * Manages the conversation lifecycle for the AI assistant panel.
 *
 * States:
 *   idle        - No active conversation, waiting for user input
 *   composing   - User is typing a message
 *   waiting     - Message sent, waiting for LLM response
 *   streaming   - Receiving streamed response from LLM
 *   error       - Recoverable error state
 *
 * @module ai/ai_state_machine
 */

import { StateMachine } from '../core/state_machine.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const AI_STATES = Object.freeze({
    IDLE:        'idle',
    COMPOSING:   'composing',
    WAITING:     'waiting',
    STREAMING:   'streaming',
    ERROR:       'error',
});

export const AI_TRANSITIONS = Object.freeze({
    START_COMPOSE:   'ai:compose:start',
    STOP_COMPOSE:    'ai:compose:stop',
    SEND_MESSAGE:    'ai:message:send',
    STREAM_START:    'ai:stream:start',
    STREAM_COMPLETE: 'ai:stream:complete',
    CANCEL:          'ai:cancel',
    ERROR:           'ai:error',
    RESET:           'ai:reset',
});

export const AI_BUS_EVENTS = Object.freeze({
    STATE_CHANGED:      'ai:state:changed',
    MESSAGE_SENT:       'ai:chat:message:sent',
    STREAM_CHUNK:       'ai:stream:chunk',
    STREAM_COMPLETE:    'ai:stream:complete',
    STATUS_CHANGED:     'ai:status:changed',
    MODE_CHANGED:       'ai:mode:changed',
    CONVERSATION_NEW:   'ai:conversation:new',
    CONVERSATION_LOADED:'ai:conversation:loaded',
    ERROR:              'ai:error',
});


// ─── State Machine ──────────────────────────────────────────────────────────

export class AiStateMachine {

    /** @type {StateMachine} */
    #machine;

    /** @type {import('../core/event_bus.js').default} */
    #eventBus;

    /** Current conversation metadata */
    #conversationId = null;
    #mode = 'ask';                // 'ask' | 'edit'
    #lastError = null;

    /**
     * @param {object} deps
     * @param {import('../core/event_bus.js').default} deps.eventBus
     * @param {object} [deps.logger]
     */
    constructor({ eventBus, logger }) {
        this.#eventBus = eventBus;

        const self = this;

        this.#machine = new StateMachine({
            name: 'ai-chat',
            initialState: AI_STATES.IDLE,
            states: {
                [AI_STATES.IDLE]: {
                    onEnter() {
                        self.#lastError = null;
                        self.#emitState();
                    },
                    transitions: {
                        [AI_TRANSITIONS.START_COMPOSE]: {
                            target: AI_STATES.COMPOSING,
                        },
                        [AI_TRANSITIONS.SEND_MESSAGE]: {
                            target: AI_STATES.WAITING,
                            guard: (ctx) => !!ctx.payload?.message,
                            action: (ctx) => self.#onMessageSent(ctx.payload),
                        },
                    },
                },

                [AI_STATES.COMPOSING]: {
                    onEnter() { self.#emitState(); },
                    transitions: {
                        [AI_TRANSITIONS.STOP_COMPOSE]: {
                            target: AI_STATES.IDLE,
                        },
                        [AI_TRANSITIONS.SEND_MESSAGE]: {
                            target: AI_STATES.WAITING,
                            guard: (ctx) => !!ctx.payload?.message,
                            action: (ctx) => self.#onMessageSent(ctx.payload),
                        },
                    },
                },

                [AI_STATES.WAITING]: {
                    onEnter() { self.#emitState(); },
                    transitions: {
                        [AI_TRANSITIONS.STREAM_START]: {
                            target: AI_STATES.STREAMING,
                        },
                        [AI_TRANSITIONS.STREAM_COMPLETE]: {
                            target: AI_STATES.IDLE,
                            action: (ctx) => self.#onStreamComplete(ctx.payload),
                        },
                        [AI_TRANSITIONS.CANCEL]: {
                            target: AI_STATES.IDLE,
                        },
                        [AI_TRANSITIONS.ERROR]: {
                            target: AI_STATES.ERROR,
                            action: (ctx) => self.#onError(ctx.payload),
                        },
                        [AI_TRANSITIONS.RESET]: {
                            target: AI_STATES.IDLE,
                        },
                    },
                },

                [AI_STATES.STREAMING]: {
                    onEnter() { self.#emitState(); },
                    transitions: {
                        [AI_TRANSITIONS.STREAM_COMPLETE]: {
                            target: AI_STATES.IDLE,
                            action: (ctx) => self.#onStreamComplete(ctx.payload),
                        },
                        [AI_TRANSITIONS.CANCEL]: {
                            target: AI_STATES.IDLE,
                        },
                        [AI_TRANSITIONS.ERROR]: {
                            target: AI_STATES.ERROR,
                            action: (ctx) => self.#onError(ctx.payload),
                        },
                        [AI_TRANSITIONS.RESET]: {
                            target: AI_STATES.IDLE,
                        },
                    },
                },

                [AI_STATES.ERROR]: {
                    onEnter() { self.#emitState(); },
                    transitions: {
                        [AI_TRANSITIONS.RESET]: {
                            target: AI_STATES.IDLE,
                        },
                        [AI_TRANSITIONS.SEND_MESSAGE]: {
                            target: AI_STATES.WAITING,
                            guard: (ctx) => !!ctx.payload?.message,
                            action: (ctx) => self.#onMessageSent(ctx.payload),
                        },
                    },
                },
            },
            eventBus,
            logger,
        });
    }

    // ─── Public API ─────────────────────────────────────────────────────

    getState() { return this.#machine.getState(); }

    get conversationId() { return this.#conversationId; }
    set conversationId(id) { this.#conversationId = id; }

    get mode() { return this.#mode; }
    get lastError() { return this.#lastError; }

    setMode(mode) {
        if (mode !== 'ask' && mode !== 'edit') return;
        this.#mode = mode;
        this.#eventBus.emit(AI_BUS_EVENTS.MODE_CHANGED, { mode });
    }

    startCompose() {
        return this.#machine.transition(AI_TRANSITIONS.START_COMPOSE);
    }

    stopCompose() {
        return this.#machine.transition(AI_TRANSITIONS.STOP_COMPOSE);
    }

    sendMessage(message, conversationId = null) {
        if (conversationId) this.#conversationId = conversationId;
        return this.#machine.transition(AI_TRANSITIONS.SEND_MESSAGE, { message });
    }

    streamStart() {
        return this.#machine.transition(AI_TRANSITIONS.STREAM_START);
    }

    streamComplete(payload) {
        const { operations, dslDiff, responseText, messageId } = payload;
        return this.#machine.transition(AI_TRANSITIONS.STREAM_COMPLETE, {
            operations, dslDiff, responseText, messageId,
        });
    }

    cancel() {
        return this.#machine.transition(AI_TRANSITIONS.CANCEL);
    }

    error(message, detail = null) {
        return this.#machine.transition(AI_TRANSITIONS.ERROR, { message, detail });
    }

    reset() {
        return this.#machine.transition(AI_TRANSITIONS.RESET);
    }

    newConversation() {
        this.#conversationId = null;
        this.#machine.reset(AI_STATES.IDLE);
        this.#eventBus.emit(AI_BUS_EVENTS.CONVERSATION_NEW);
    }

    loadConversation(conversationId) {
        this.#conversationId = conversationId;
        this.#machine.reset(AI_STATES.IDLE);
        this.#eventBus.emit(AI_BUS_EVENTS.CONVERSATION_LOADED, { conversationId });
    }

    canSend() {
        const state = this.getState();
        return state === AI_STATES.IDLE
            || state === AI_STATES.COMPOSING
            || state === AI_STATES.ERROR;
    }

    isProcessing() {
        const state = this.getState();
        return state === AI_STATES.WAITING
            || state === AI_STATES.STREAMING;
    }

    // ─── Private ────────────────────────────────────────────────────────

    #onMessageSent(payload) {
        this.#eventBus.emit(AI_BUS_EVENTS.MESSAGE_SENT, {
            conversationId: this.#conversationId,
            text: payload.message,
            mode: this.#mode,
        });
    }

    #onStreamComplete(payload) {
        this.#eventBus.emit(AI_BUS_EVENTS.STREAM_COMPLETE, {
            conversationId: this.#conversationId,
            operations: payload?.operations,
            dslDiff: payload?.dslDiff,
        });
    }

    #onError(payload) {
        this.#lastError = payload?.message || 'Unknown error';
        this.#eventBus.emit(AI_BUS_EVENTS.ERROR, {
            conversationId: this.#conversationId,
            message: this.#lastError,
            detail: payload?.detail,
        });
    }

    #emitState() {
        this.#eventBus.emit(AI_BUS_EVENTS.STATE_CHANGED, {
            state: this.getState(),
            conversationId: this.#conversationId,
            mode: this.#mode,
        });
    }
}
