// STUB — see ui/js/__stubs__.js
import { stubFn, warnStub } from '../../__stubs__.js';

export const openLoopAnalysisWindow = stubFn('openLoopAnalysisWindow');

// loop_config_panel.js calls these; return harmless empties so the panel renders.
export function resolveLoopLabels(_loops, _registry) {
    warnStub('loop_analysis_window.resolveLoopLabels');
    return [];
}

export function loopFingerprint(_nodes) {
    warnStub('loop_analysis_window.loopFingerprint');
    return '';
}
