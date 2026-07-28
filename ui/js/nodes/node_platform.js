// STUB — see ui/js/__stubs__.js
import { warnStub } from '../__stubs__.js'; warnStub('nodes/node_platform');

// Event-name constants HistoryService and others subscribe to. Values are
// arbitrary strings — any unique string works since they're just event ids.
export class NodePlatform {
    static EVENTS = {
        CREATED:          'node:created',
        REMOVED:          'node:removed',
        SNAPSHOT_UPDATED: 'node:snapshot:updated',
        SELECTED:         'node:selected',
    };
}
export default NodePlatform;
