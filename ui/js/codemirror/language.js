// STUB — see ui/js/__stubs__.js
// EcoLang language extension for legacy editor.js. Phase 0 EcoAgent uses
// PythonEditor (no language tokenizer yet); legacy expression cells that
// still reach for editor.js will get a no-op language extension.
import { warnStub } from '../__stubs__.js';
warnStub('codemirror/language');

export const ecolangLanguage = [];
export const ecolangParser = null;
export function tokenize() { return []; }
export function highlightToHtml(s) { return String(s); }
