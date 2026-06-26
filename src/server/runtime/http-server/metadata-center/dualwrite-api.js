import { MetadataCenter } from './metadata-center.js';
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');
const CAMEL_FAMILY = {
    request_truth: 'requestTruth',
    continuation_context: 'continuationContext',
    runtime_control: 'runtimeControl',
    provider_observation: 'providerObservation',
    client_attachment_scope: 'clientAttachmentScope',
    debug_snapshot: 'debugSnapshot'
};
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readRustSnapshot(target) {
    const current = Reflect.get(target, RUST_SNAPSHOT_SYMBOL);
    return asRecord(current) ? structuredClone(current) : {};
}
function writeRustSnapshot(target, snapshot) {
    Reflect.set(target, RUST_SNAPSHOT_SYMBOL, structuredClone(snapshot));
}
function readTrimmedString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
function assertMetadataCenterScope(args) {
    const expectedRequestId = readTrimmedString(args.expectedScope?.requestId);
    const expectedSessionId = readTrimmedString(args.expectedScope?.sessionId);
    if (!expectedRequestId && !expectedSessionId) {
        return;
    }
    const centerTruth = MetadataCenter.read(args.source)?.readRequestTruth() ?? {};
    const rustTruth = readRustSnapshot(args.source).requestTruth ?? {};
    const actualRequestId = readTrimmedString(rustTruth.requestId) ?? readTrimmedString(centerTruth.requestId);
    const actualSessionId = readTrimmedString(rustTruth.sessionId) ?? readTrimmedString(centerTruth.sessionId);
    if (expectedRequestId && actualRequestId !== expectedRequestId) {
        throw new Error(`MetadataCenter ${args.operation} scope mismatch: requestId expected=${expectedRequestId} actual=${actualRequestId ?? '<missing>'}`);
    }
    if (expectedSessionId && actualSessionId !== expectedSessionId) {
        throw new Error(`MetadataCenter ${args.operation} scope mismatch: sessionId expected=${expectedSessionId} actual=${actualSessionId ?? '<missing>'}`);
    }
}
function writeJsMirror(input) {
    const center = MetadataCenter.attach(input.target);
    switch (input.family) {
        case 'request_truth':
            center.writeRequestTruth(input.key, input.value, input.writer, input.reason);
            return;
        case 'continuation_context':
            center.writeContinuationContext(input.key, input.value, input.writer, input.reason);
            return;
        case 'runtime_control':
            center.writeRuntimeControl(input.key, input.value, input.writer, input.reason);
            return;
        case 'provider_observation':
            center.writeProviderObservation(input.key, input.value, input.writer, input.reason);
            return;
        case 'client_attachment_scope':
            center.writeClientAttachmentScope(input.key, input.value, input.writer, input.reason);
            return;
        case 'debug_snapshot':
            center.writeDebugSnapshot(input.key, input.value, input.writer, input.reason);
            return;
    }
}
function writeRustMirror(input) {
    const snapshot = readRustSnapshot(input.target);
    const family = CAMEL_FAMILY[input.family];
    const row = asRecord(snapshot[family]) ?? {};
    row[input.key] = structuredClone(input.value);
    snapshot[family] = row;
    writeRustSnapshot(input.target, snapshot);
}
export function writeMetadataCenterSlot(input) {
    if (input.family !== 'request_truth') {
        assertMetadataCenterScope({
            source: input.target,
            expectedScope: input.expectedScope,
            operation: `write ${input.family}.${input.key}`
        });
    }
    writeJsMirror(input);
    writeRustMirror(input);
}
export function readMetadataCenterSlot(_input) {
    assertMetadataCenterScope({
        source: _input.source,
        expectedScope: _input.expectedScope,
        operation: `read ${_input.family}.${_input.key}`
    });
    const snapshot = buildMetadataCenterRustSnapshot(_input.source);
    const family = CAMEL_FAMILY[_input.family];
    const rustValue = asRecord(snapshot[family])?.[_input.key];
    if (rustValue !== undefined) {
        return rustValue;
    }
    const center = MetadataCenter.read(_input.source);
    if (!center) {
        return undefined;
    }
    switch (_input.family) {
        case 'request_truth':
            return center.readRequestTruth()[_input.key];
        case 'continuation_context':
            return center.readContinuationContext()[_input.key];
        case 'runtime_control':
            return center.readRuntimeControl()[_input.key];
        case 'provider_observation':
            return center.readProviderObservation()[_input.key];
        case 'client_attachment_scope':
            return center.readClientAttachmentScope()[_input.key];
        case 'debug_snapshot':
            return center.readDebugSnapshot()[_input.key];
    }
}
export function buildMetadataCenterRustSnapshot(source) {
    const rustSnapshot = readRustSnapshot(source);
    const center = MetadataCenter.read(source);
    if (!center) {
        return rustSnapshot;
    }
    return {
        requestTruth: {
            ...center.readRequestTruth(),
            ...(rustSnapshot.requestTruth ?? {})
        },
        continuationContext: {
            ...center.readContinuationContext(),
            ...(rustSnapshot.continuationContext ?? {})
        },
        runtimeControl: {
            ...center.readRuntimeControl(),
            ...(rustSnapshot.runtimeControl ?? {})
        },
        providerObservation: {
            ...center.readProviderObservation(),
            ...(rustSnapshot.providerObservation ?? {})
        },
        clientAttachmentScope: {
            ...center.readClientAttachmentScope(),
            ...(rustSnapshot.clientAttachmentScope ?? {})
        },
        debugSnapshot: {
            ...center.readDebugSnapshot(),
            ...(rustSnapshot.debugSnapshot ?? {})
        }
    };
}
export function applyMetadataCenterRustWriteResult(args) {
    writeRustSnapshot(args.target, args.snapshot);
}
