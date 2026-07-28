/**
 * Stub helper used by all the *_stub.js files at deliberately-empty paths.
 *
 * These exist only so the existing bootstrap and surviving pages can be
 * imported without `Module not found` errors. A `PermissiveStub` instance
 * is a Proxy: any method call that isn't explicitly defined on the stub
 * falls back to a no-op function (logs once, returns undefined).
 *
 * Failure mode goes from "TypeError: ctrl.foo is not a function" to a
 * console.warn, which lets the bootstrap and pages get further before
 * tripping a real semantic problem.
 *
 * Stubs ARE technically compatibility shims, which Ecosim's CLAUDE.md
 * recommends against. We accept this for the integration phase only:
 * they're temporary scaffolding so the frontend loads, and each one will
 * be replaced as we touch its area. New features must NOT add stubs.
 */

const _warned = new Set();

export function warnStub(name) {
    if (_warned.has(name)) return;
    _warned.add(name);
    console.warn(`[stub] ${name} — see ui/js/__stubs__.js`);
}

// Method names that callers chain on (return value is itself called).
// For these we return a no-op function so `unsub()` doesn't crash.
const RETURNS_UNSUBSCRIBE = new Set([
    'on', 'off', 'once',
    'addEventListener', 'removeEventListener',
    'subscribe', 'unsubscribe',
]);

// Any method whose name *starts with* one of these verbs is treated as async
// and returns a resolved Promise. Restricted to verbs that nearly always
// wrap async work — explicitly NOT including `get*` / `init*` / `mount*`,
// which usually return synchronous values that callers chain with `||`
// fallbacks (e.g. `sim.getPhase?.() || 'idle'`).
const ASYNC_PREFIX = /^(load|fetch|save|send|run|compile|sync|reload|refresh|process)/;


function _stubMethod(label, prop) {
    return (...args) => {
        warnStub(`${label}.${String(prop)}`);
        if (RETURNS_UNSUBSCRIBE.has(prop)) return () => {};
        if (typeof prop === 'string' && ASYNC_PREFIX.test(prop)) {
            return Promise.resolve(null);
        }
        return undefined;
    };
}


export class PermissiveStub {
    constructor(label, opts = {}) {
        this._label = label;
        this._opts = opts;
        warnStub(label);
        return new Proxy(this, {
            get(target, prop, receiver) {
                if (prop in target) return Reflect.get(target, prop, receiver);
                if (typeof prop === 'symbol') return undefined;
                if (prop === 'then') return undefined; // never accidentally thenable
                return _stubMethod(target._label, prop);
            },
        });
    }
}


export class StubPage extends PermissiveStub {
    constructor(label, opts) { super(label, opts); }
    async mount() {}
    async hydrate() {}
    show() {}
    hide() {}
    dispose() {}
}


export class StubController extends PermissiveStub {
    constructor(label, opts) { super(label, opts); }
    initialize() {}
    dispose() {}
    on() { return () => {}; }
    off() {}
}


export function stubFn(label) {
    return function (..._args) {
        warnStub(label);
        return null;
    };
}
