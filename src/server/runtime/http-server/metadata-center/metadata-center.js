// feature_id: hub.metadata_center_mainline
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const METADATA_CENTER_SESSION_BUFFER_SYMBOL = Symbol.for('routecodex.metadataCenter.sessionBuffer');
const METADATA_CENTER_SESSION_BUFFER_LIMIT = 10;
function now() {
    return Date.now();
}
function buildSlot(args) {
    return {
        value: args.value,
        family: args.family,
        writtenBy: args.writtenBy,
        status: args.status ?? 'active',
        writePolicy: args.writePolicy,
        version: (args.previous?.version ?? 0) + 1,
        history: [
            ...(args.previous?.history ?? []),
            {
                value: args.value,
                module: args.writtenBy.module,
                symbol: args.writtenBy.symbol,
                stage: args.writtenBy.stage,
                at: now(),
                ...(args.reason ? { reason: args.reason } : {})
            }
        ]
    };
}
const METADATA_CENTER_STATUS_ORDER = {
    active: 0,
    consumed: 1,
    finalized: 2,
    released: 3,
};
const HTTP_RESPONSE_METADATA_RELEASE_WRITER = {
    module: 'src/server/runtime/http-server/metadata-center/metadata-center.ts',
    symbol: 'releaseMetadataCenterForHttpResponse',
    stage: 'ServerRespOutbound05ClientFrame',
};
function bindInternalStateCarrier(target, center) {
    Reflect.set(target, METADATA_CENTER_SYMBOL, center);
    target.__metadataCenter = center.snapshot();
}
function transitionSlotStatus(args) {
    if (METADATA_CENTER_STATUS_ORDER[args.previous.status] >= METADATA_CENTER_STATUS_ORDER[args.status]) {
        return args.previous;
    }
    return {
        ...args.previous,
        status: args.status,
        version: args.previous.version + 1,
        history: [
            ...args.previous.history,
            {
                value: args.previous.value,
                module: args.changedBy.module,
                symbol: args.changedBy.symbol,
                stage: args.changedBy.stage,
                at: now(),
                reason: args.reason ?? `status:${args.status}`,
            },
        ],
    };
}
function isMetadataCenterLike(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value;
    return (typeof candidate.readRequestTruth === 'function'
        && typeof candidate.writeRequestTruth === 'function'
        && typeof candidate.readRuntimeControl === 'function'
        && typeof candidate.writeRuntimeControl === 'function');
}
export class MetadataCenter {
    state;
    constructor() {
        this.state = {
            requestTruth: {},
            continuationContext: {},
            runtimeControl: {},
            providerObservation: {},
            responseObservation: {},
            closeoutStatus: {},
            debugSnapshot: {}
        };
    }
    static attach(target) {
        const existing = Reflect.get(target, METADATA_CENTER_SYMBOL);
        if (isMetadataCenterLike(existing)) {
            bindInternalStateCarrier(target, existing);
            return existing;
        }
        const created = new MetadataCenter();
        bindInternalStateCarrier(target, created);
        return created;
    }
    static bind(target, center) {
        bindInternalStateCarrier(target, center);
    }
    static read(target) {
        if (!target) {
            return undefined;
        }
        const existing = Reflect.get(target, METADATA_CENTER_SYMBOL);
        return isMetadataCenterLike(existing) ? existing : undefined;
    }
    writeRequestTruth(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.requestTruth[key];
        if (previous) {
            throw new Error(`MetadataCenter request_truth.${String(key)} is write-once and already set`);
        }
        this.state.requestTruth[key] = buildSlot({
            value,
            family: 'request_truth',
            writtenBy,
            writePolicy: 'write_once',
            previous,
            reason
        });
    }
    writeContinuationContext(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.continuationContext[key];
        this.state.continuationContext[key] = buildSlot({
            value,
            family: 'continuation_context',
            writtenBy,
            writePolicy: 'replaceable_by_owner_only',
            previous,
            reason
        });
    }
    readRequestTruth() {
        return {
            requestId: this.state.requestTruth.requestId?.value,
            pipelineId: this.state.requestTruth.pipelineId?.value,
            entryEndpoint: this.state.requestTruth.entryEndpoint?.value,
            sessionId: this.state.requestTruth.sessionId?.value,
            conversationId: this.state.requestTruth.conversationId?.value,
            clientRequestId: this.state.requestTruth.clientRequestId?.value,
            portScope: this.state.requestTruth.portScope?.value
        };
    }
    readContinuationContext() {
        return {
            responsesResume: this.state.continuationContext.responsesResume?.value,
            previousResponseId: this.state.continuationContext.previousResponseId?.value,
            responseId: this.state.continuationContext.responseId?.value,
            toolOutputs: this.state.continuationContext.toolOutputs?.value,
            continuationOwner: this.state.continuationContext.continuationOwner?.value,
            resumeFrom: this.state.continuationContext.resumeFrom?.value,
            chainId: this.state.continuationContext.chainId?.value,
            stickyScope: this.state.continuationContext.stickyScope?.value
        };
    }
    writeRuntimeControl(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.runtimeControl[key];
        this.state.runtimeControl[key] = buildSlot({
            value,
            family: 'runtime_control',
            writtenBy,
            writePolicy: 'replaceable_by_owner_only',
            previous,
            reason
        });
    }
    releaseRuntimeControl(key, changedBy, reason) {
        void changedBy;
        void reason;
        if (!this.state.runtimeControl[key]) {
            return;
        }
        delete this.state.runtimeControl[key];
    }
    readRuntimeControl() {
        return {
            routeHint: this.state.runtimeControl.routeHint?.value,
            routeName: this.state.runtimeControl.routeName?.value,
            routeId: this.state.runtimeControl.routeId?.value,
            providerProtocol: this.state.runtimeControl.providerProtocol?.value,
            retryProviderKey: this.state.runtimeControl.retryProviderKey?.value,
            preselectedRoute: this.state.runtimeControl.preselectedRoute?.value,
            responsesContinuationSavedAtChatProcessExit: this.state.runtimeControl.responsesContinuationSavedAtChatProcessExit?.value,
            stopless: this.state.runtimeControl.stopless?.value,
            stopMessageCompareContext: this.state.runtimeControl.stopMessageCompareContext?.value,
            serverToolLoopState: this.state.runtimeControl.serverToolLoopState?.value,
            stopMessageEnabled: this.state.runtimeControl.stopMessageEnabled?.value,
            stopMessageExcludeDirect: this.state.runtimeControl.stopMessageExcludeDirect?.value,
            streamIntent: this.state.runtimeControl.streamIntent?.value,
            clientAbort: this.state.runtimeControl.clientAbort?.value
        };
    }
    writeProviderObservation(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.providerObservation[key];
        this.state.providerObservation[key] = buildSlot({
            value,
            family: 'provider_observation',
            writtenBy,
            writePolicy: 'append_only',
            previous,
            reason
        });
    }
    readProviderObservation() {
        return {
            target: this.state.providerObservation.target?.value,
            providerKey: this.state.providerObservation.providerKey?.value,
            assignedModelId: this.state.providerObservation.assignedModelId?.value,
            modelId: this.state.providerObservation.modelId?.value,
            clientModelId: this.state.providerObservation.clientModelId?.value,
            compatibilityProfile: this.state.providerObservation.compatibilityProfile?.value,
            responseSemantics: this.state.providerObservation.responseSemantics?.value,
            finishReason: this.state.providerObservation.finishReason?.value
        };
    }
    writeResponseObservation(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.responseObservation[key];
        this.state.responseObservation[key] = buildSlot({
            value,
            family: 'response_observation',
            writtenBy,
            writePolicy: 'append_only',
            previous,
            reason
        });
    }
    readResponseObservation() {
        return {
            responseId: this.state.responseObservation.responseId?.value,
            status: this.state.responseObservation.status?.value,
            finishReason: this.state.responseObservation.finishReason?.value,
            protocolKind: this.state.responseObservation.protocolKind?.value
        };
    }
    writeCloseoutStatus(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.closeoutStatus[key];
        this.state.closeoutStatus[key] = buildSlot({
            value,
            family: 'closeout_status',
            writtenBy,
            writePolicy: 'finalize_only',
            previous,
            reason
        });
    }
    readCloseoutStatus() {
        return {
            finalized: this.state.closeoutStatus.finalized?.value,
            released: this.state.closeoutStatus.released?.value,
            releasedAt: this.state.closeoutStatus.releasedAt?.value,
            releaseReason: this.state.closeoutStatus.releaseReason?.value,
            releasedByStage: this.state.closeoutStatus.releasedByStage?.value
        };
    }
    writeDebugSnapshot(key, value, writtenBy, reason) {
        if (value === undefined) {
            return;
        }
        const previous = this.state.debugSnapshot[key];
        this.state.debugSnapshot[key] = buildSlot({
            value,
            family: 'debug_snapshot',
            writtenBy,
            writePolicy: 'append_only',
            previous,
            reason
        });
    }
    readDebugSnapshot() {
        return {
            snapshotId: this.state.debugSnapshot.snapshotId?.value,
            bridgeHistory: this.state.debugSnapshot.bridgeHistory?.value,
            traceMarkers: this.state.debugSnapshot.traceMarkers?.value,
            hubStageTop: this.state.debugSnapshot.hubStageTop?.value
        };
    }
    markReleased(writtenBy, reason) {
        for (const key of Object.keys(this.state.requestTruth)) {
            const slot = this.state.requestTruth[key];
            if (!slot) {
                continue;
            }
            this.state.requestTruth[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.continuationContext)) {
            const slot = this.state.continuationContext[key];
            if (!slot) {
                continue;
            }
            this.state.continuationContext[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.runtimeControl)) {
            const slot = this.state.runtimeControl[key];
            if (!slot) {
                continue;
            }
            this.state.runtimeControl[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.providerObservation)) {
            const slot = this.state.providerObservation[key];
            if (!slot) {
                continue;
            }
            this.state.providerObservation[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.responseObservation)) {
            const slot = this.state.responseObservation[key];
            if (!slot) {
                continue;
            }
            this.state.responseObservation[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.closeoutStatus)) {
            const slot = this.state.closeoutStatus[key];
            if (!slot) {
                continue;
            }
            this.state.closeoutStatus[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
        for (const key of Object.keys(this.state.debugSnapshot)) {
            const slot = this.state.debugSnapshot[key];
            if (!slot) {
                continue;
            }
            this.state.debugSnapshot[key] = transitionSlotStatus({
                previous: slot,
                status: 'released',
                changedBy: writtenBy,
                reason,
            });
        }
    }
    snapshot() {
        return this.state;
    }
}
export const METADATA_CENTER_RUNTIME_SYMBOL = METADATA_CENTER_SYMBOL;
function getSessionBuffer() {
    const globalRecord = globalThis;
    const existing = globalRecord[METADATA_CENTER_SESSION_BUFFER_SYMBOL];
    if (existing instanceof Map) {
        return existing;
    }
    const created = new Map();
    globalRecord[METADATA_CENTER_SESSION_BUFFER_SYMBOL] = created;
    return created;
}
function cloneMetadataCenterState(state) {
    return structuredClone(state);
}
function rememberReleasedMetadataCenter(center, reason) {
    const requestTruth = center.readRequestTruth();
    const sessionId = requestTruth.sessionId?.trim();
    if (!sessionId) {
        return;
    }
    const buffer = getSessionBuffer();
    const entries = buffer.get(sessionId) ?? [];
    entries.push({
        ...(requestTruth.requestId ? { requestId: requestTruth.requestId } : {}),
        sessionId,
        releasedAt: now(),
        ...(reason ? { reason } : {}),
        state: cloneMetadataCenterState(center.snapshot()),
    });
    if (entries.length > METADATA_CENTER_SESSION_BUFFER_LIMIT) {
        entries.splice(0, entries.length - METADATA_CENTER_SESSION_BUFFER_LIMIT);
    }
    buffer.set(sessionId, entries);
}
export function readReleasedMetadataCenterSessionBuffer(sessionId) {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        return [];
    }
    return (getSessionBuffer().get(trimmed) ?? []).map((entry) => structuredClone(entry));
}
export function releaseMetadataCenterForHttpResponse(metadata, reason) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return;
    }
    const center = MetadataCenter.read(metadata);
    if (!center) {
        return;
    }
    center.markReleased(HTTP_RESPONSE_METADATA_RELEASE_WRITER, reason);
    rememberReleasedMetadataCenter(center, reason);
}
