// STUB — see ui/js/__stubs__.js
// GeneratorCell is an ODE/DSL-specific Ecosim cell. Replaced by ABM cell types
// (agent_class, agent_instance, market_config) — see ui/js/notebook/cells/.
import { CellBase } from './cell_base.js';
export class GeneratorCell extends CellBase {
    static TYPE = 'generator';
    _getTabs() { return []; }
    _getStandardActions() { return new Set(); }
    async renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="cell-stub"><em>GeneratorCell (Ecosim ODE cell — not used in EcoAgent)</em></div>';
    }
}
