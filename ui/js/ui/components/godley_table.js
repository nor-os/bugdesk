// STUB — see ui/js/__stubs__.js
// Both import names seen in the wild: GodleyTable (older code paths) and
// GodleyTableComponent (newer). Export both pointing at the same no-op stub.
import { PermissiveStub } from '../../__stubs__.js';

export class GodleyTableComponent extends PermissiveStub {
    constructor(opts) { super('GodleyTableComponent', opts); }
}

export const GodleyTable = GodleyTableComponent;
export default GodleyTableComponent;
