import { requireString, requireNumber, optionalPlainObject, optionalArray } from '../validators.js';

export class ConnectionDTO {
    constructor({ id, namespaceId = null, source, target, metadata = {}, geometry = null, tags = [], createdAt = Date.now(), updatedAt = Date.now() } = {}) {
        this.id = requireString(id, 'connection.id');
        this.namespaceId = namespaceId ? requireString(namespaceId, 'connection.namespaceId') : null;
        this.source = ConnectionDTO.#normalizeEndpoint(source, 'source');
        this.target = ConnectionDTO.#normalizeEndpoint(target, 'target');
        this.metadata = optionalPlainObject(metadata, 'connection.metadata');
        this.geometry = geometry === null || geometry === undefined ? null : optionalPlainObject(geometry, 'connection.geometry');
        this.tags = optionalArray(tags, 'connection.tags');
        this.createdAt = requireNumber(createdAt, 'connection.createdAt');
        this.updatedAt = requireNumber(updatedAt, 'connection.updatedAt');
    }

    static fromJSON(json = {}) {
        return new ConnectionDTO(json);
    }

    toJSON() {
        return {
            id: this.id,
            namespaceId: this.namespaceId,
            source: { ...this.source },
            target: { ...this.target },
            metadata: { ...this.metadata },
            geometry: this.geometry ? { ...this.geometry } : null,
            tags: [...this.tags],
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    static #normalizeEndpoint(endpoint, label) {
        if (!endpoint || typeof endpoint !== 'object') {
            throw new TypeError(`connection.${label} must be an object`);
        }
        return {
            nodeId: requireString(endpoint.nodeId, `connection.${label}.nodeId`),
            connectorId: endpoint.connectorId ? requireString(endpoint.connectorId, `connection.${label}.connectorId`) : null,
            role: endpoint.role ?? null,
            portIndex: Number.isFinite(endpoint.portIndex) ? endpoint.portIndex : null,
            namespaceId: endpoint.namespaceId ? requireString(endpoint.namespaceId, `connection.${label}.namespaceId`) : null,
        };
    }
}
