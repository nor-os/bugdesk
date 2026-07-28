// STUB — see ui/js/__stubs__.js
// ConditionalSwitchCell is an ODE/DSL-specific Ecosim cell. Replaced by ABM cell types
// (agent_class, agent_instance, market_config) — see ui/js/notebook/cells/.
import { CellBase } from './cell_base.js';
export class ConditionalSwitchCell extends CellBase {
    static TYPE = 'conditional-switch';
    _getTabs() { return []; }
    _getStandardActions() { return new Set(); }
    async renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="cell-stub"><em>ConditionalSwitchCell (Ecosim ODE cell — not used in EcoAgent)</em></div>';
    }
}
