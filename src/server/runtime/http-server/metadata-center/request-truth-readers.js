import { MetadataCenter } from './metadata-center.js';
import { writeMetadataCenterSlot } from './dualwrite-api.js';
function readTrimmedString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
export function readRuntimeRequestTruthSessionId(metadata) {
    if (!metadata) {
        return undefined;
    }
    const center = MetadataCenter.read(metadata);
    return readTrimmedString(center?.readRequestTruth().sessionId);
}
export function writeStoplessRuntimeControl(args) {
    writeMetadataCenterSlot({
        target: args.metadata,
        family: 'runtime_control',
        key: 'stopless',
        value: args.value,
        writer: args.writer,
        reason: args.reason
    });
}
function asFlatRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
function readBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function normalizeHubStageTopEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return undefined;
    }
    const record = entry;
    const stage = readTrimmedString(record.stage);
    const totalMs = typeof record.totalMs === 'number' && Number.isFinite(record.totalMs)
        ? Math.max(0, Math.round(record.totalMs))
        : undefined;
    if (!stage || totalMs === undefined) {
        return undefined;
    }
    const count = typeof record.count === 'number' && Number.isFinite(record.count)
        ? Math.max(0, Math.floor(record.count))
        : undefined;
    const avgMs = typeof record.avgMs === 'number' && Number.isFinite(record.avgMs)
        ? Math.max(0, Math.round(record.avgMs))
        : undefined;
    const maxMs = typeof record.maxMs === 'number' && Number.isFinite(record.maxMs)
        ? Math.max(0, Math.round(record.maxMs))
        : undefined;
    return {
        stage,
        totalMs,
        ...(count !== undefined ? { count } : {}),
        ...(avgMs !== undefined ? { avgMs } : {}),
        ...(maxMs !== undefined ? { maxMs } : {}),
    };
}
export function readRuntimeRequestTruthIdentifiers(metadata) {
    if (!metadata) {
        return {};
    }
    const center = MetadataCenter.read(metadata);
    const requestTruth = center?.readRequestTruth();
    const sessionId = readTrimmedString(requestTruth?.sessionId);
    const conversationId = readTrimmedString(requestTruth?.conversationId);
    return {
        ...(sessionId ? { sessionId } : {}),
        ...(conversationId ? { conversationId } : {}),
    };
}
export function readRuntimeProviderObservationProjection(metadata) {
    if (!metadata) {
        return {};
    }
    const centerObservation = MetadataCenter.read(metadata)?.readProviderObservation();
    const target = asFlatRecord(centerObservation?.target);
    const responseSemantics = asFlatRecord(centerObservation?.responseSemantics);
    const providerKey = readTrimmedString(centerObservation?.providerKey);
    const assignedModelId = readTrimmedString(centerObservation?.assignedModelId);
    const modelId = readTrimmedString(centerObservation?.modelId);
    const clientModelId = readTrimmedString(centerObservation?.clientModelId);
    const compatibilityProfile = readTrimmedString(centerObservation?.compatibilityProfile);
    const finishReason = readTrimmedString(centerObservation?.finishReason);
    return {
        ...(target ? { target } : {}),
        ...(providerKey ? { providerKey } : {}),
        ...(assignedModelId ? { assignedModelId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(clientModelId ? { clientModelId } : {}),
        ...(compatibilityProfile ? { compatibilityProfile } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(responseSemantics ? { responseSemantics } : {}),
    };
}
export function readRuntimeDebugSnapshotProjection(metadata) {
    if (!metadata) {
        return {};
    }
    const debugSnapshot = MetadataCenter.read(metadata)?.readDebugSnapshot();
    const snapshotId = readTrimmedString(debugSnapshot?.snapshotId);
    const bridgeHistory = Array.isArray(debugSnapshot?.bridgeHistory)
        ? debugSnapshot.bridgeHistory
        : undefined;
    const traceMarkers = Array.isArray(debugSnapshot?.traceMarkers)
        ? debugSnapshot.traceMarkers
        : undefined;
    const hubStageTop = Array.isArray(debugSnapshot?.hubStageTop)
        ? debugSnapshot.hubStageTop
            .map(normalizeHubStageTopEntry)
            .filter((entry) => Boolean(entry))
        : undefined;
    return {
        ...(snapshotId ? { snapshotId } : {}),
        ...(bridgeHistory ? { bridgeHistory } : {}),
        ...(traceMarkers ? { traceMarkers } : {}),
        ...(hubStageTop && hubStageTop.length > 0 ? { hubStageTop } : {}),
    };
}
export function readRuntimeControlProjection(metadata) {
    if (!metadata) {
        return {};
    }
    const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
    const routeHint = readTrimmedString(runtimeControl?.routeHint);
    const routeName = readTrimmedString(runtimeControl?.routeName);
    const routeId = readTrimmedString(runtimeControl?.routeId);
    const providerProtocol = readTrimmedString(runtimeControl?.providerProtocol);
    const retryProviderKey = readTrimmedString(runtimeControl?.retryProviderKey);
    const preselectedRoute = asFlatRecord(runtimeControl?.preselectedRoute);
    const stopless = asFlatRecord(runtimeControl?.stopless);
    const stopMessageCompareContext = asFlatRecord(runtimeControl?.stopMessageCompareContext);
    const stopMessageEnabled = readBoolean(runtimeControl?.stopMessageEnabled);
    const stopMessageExcludeDirect = readBoolean(runtimeControl?.stopMessageExcludeDirect);
    const stopMessageClientInject = asFlatRecord(runtimeControl?.stopMessageClientInject);
    const streamIntent = readTrimmedString(runtimeControl?.streamIntent);
    const clientAbort = readBoolean(runtimeControl?.clientAbort);
    return {
        ...(routeHint ? { routeHint } : {}),
        ...(routeName ? { routeName } : {}),
        ...(routeId ? { routeId } : {}),
        ...(providerProtocol ? { providerProtocol } : {}),
        ...(retryProviderKey ? { retryProviderKey } : {}),
        ...(preselectedRoute ? { preselectedRoute } : {}),
        ...(stopless
            ? {
                stopless: {
                    ...(readTrimmedString(stopless.flowId) ? { flowId: readTrimmedString(stopless.flowId) } : {}),
                    ...(typeof stopless.repeatCount === 'number' ? { repeatCount: stopless.repeatCount } : {}),
                    ...(typeof stopless.maxRepeats === 'number' ? { maxRepeats: stopless.maxRepeats } : {}),
                    ...(readTrimmedString(stopless.triggerHint) ? { triggerHint: readTrimmedString(stopless.triggerHint) } : {}),
                    ...(readTrimmedString(stopless.continuationPrompt)
                        ? { continuationPrompt: readTrimmedString(stopless.continuationPrompt) }
                        : {}),
                    ...(asFlatRecord(stopless.schemaFeedback)
                        ? { schemaFeedback: asFlatRecord(stopless.schemaFeedback) }
                        : {}),
                    ...(typeof stopless.active === 'boolean' ? { active: stopless.active } : {}),
                    ...(typeof stopless.updatedAt === 'number' ? { updatedAt: stopless.updatedAt } : {}),
                }
            }
            : {}),
        ...(stopMessageCompareContext
            ? {
                stopMessageCompareContext: {
                    ...(typeof stopMessageCompareContext.armed === 'boolean' ? { armed: stopMessageCompareContext.armed } : {}),
                    ...(readTrimmedString(stopMessageCompareContext.mode) ? { mode: readTrimmedString(stopMessageCompareContext.mode) } : {}),
                    ...(typeof stopMessageCompareContext.allowModeOnly === 'boolean'
                        ? { allowModeOnly: stopMessageCompareContext.allowModeOnly }
                        : {}),
                    ...(typeof stopMessageCompareContext.textLength === 'number' ? { textLength: stopMessageCompareContext.textLength } : {}),
                    ...(typeof stopMessageCompareContext.maxRepeats === 'number' ? { maxRepeats: stopMessageCompareContext.maxRepeats } : {}),
                    ...(typeof stopMessageCompareContext.used === 'number' ? { used: stopMessageCompareContext.used } : {}),
                    ...(typeof stopMessageCompareContext.remaining === 'number' ? { remaining: stopMessageCompareContext.remaining } : {}),
                    ...(typeof stopMessageCompareContext.active === 'boolean' ? { active: stopMessageCompareContext.active } : {}),
                    ...(typeof stopMessageCompareContext.stopEligible === 'boolean'
                        ? { stopEligible: stopMessageCompareContext.stopEligible }
                        : {}),
                    ...(typeof stopMessageCompareContext.hasCapturedRequest === 'boolean'
                        ? { hasCapturedRequest: stopMessageCompareContext.hasCapturedRequest }
                        : {}),
                    ...(typeof stopMessageCompareContext.compactionRequest === 'boolean'
                        ? { compactionRequest: stopMessageCompareContext.compactionRequest }
                        : {}),
                    ...(typeof stopMessageCompareContext.hasSeed === 'boolean'
                        ? { hasSeed: stopMessageCompareContext.hasSeed }
                        : {}),
                    ...(readTrimmedString(stopMessageCompareContext.decision) ? { decision: readTrimmedString(stopMessageCompareContext.decision) } : {}),
                    ...(readTrimmedString(stopMessageCompareContext.reason) ? { reason: readTrimmedString(stopMessageCompareContext.reason) } : {}),
                    ...(readTrimmedString(stopMessageCompareContext.stage) ? { stage: readTrimmedString(stopMessageCompareContext.stage) } : {}),
                    ...(readTrimmedString(stopMessageCompareContext.bdWorkState) ? { bdWorkState: readTrimmedString(stopMessageCompareContext.bdWorkState) } : {}),
                    ...(readTrimmedString(stopMessageCompareContext.observationHash)
                        ? { observationHash: readTrimmedString(stopMessageCompareContext.observationHash) }
                        : {}),
                    ...(typeof stopMessageCompareContext.observationStableCount === 'number'
                        ? { observationStableCount: stopMessageCompareContext.observationStableCount }
                        : {}),
                    ...(readTrimmedString(stopMessageCompareContext.toolSignatureHash)
                        ? { toolSignatureHash: readTrimmedString(stopMessageCompareContext.toolSignatureHash) }
                        : {}),
                }
            }
            : {}),
        ...(stopMessageEnabled !== undefined ? { stopMessageEnabled } : {}),
        ...(stopMessageExcludeDirect !== undefined ? { stopMessageExcludeDirect } : {}),
        ...(stopMessageClientInject
            ? {
                stopMessageClientInject: {
                    ...(typeof stopMessageClientInject.ready === 'boolean' ? { ready: stopMessageClientInject.ready } : {}),
                    ...(readTrimmedString(stopMessageClientInject.reason) ? { reason: readTrimmedString(stopMessageClientInject.reason) } : {}),
                    ...(readTrimmedString(stopMessageClientInject.sessionScope)
                        ? { sessionScope: readTrimmedString(stopMessageClientInject.sessionScope) }
                        : {}),
                    ...(readTrimmedString(stopMessageClientInject.tmuxSessionId)
                        ? { tmuxSessionId: readTrimmedString(stopMessageClientInject.tmuxSessionId) }
                        : {}),
                }
            }
            : {}),
        ...(streamIntent ? { streamIntent } : {}),
        ...(clientAbort !== undefined ? { clientAbort } : {}),
    };
}
export function readRuntimeServerToolProjection(metadata) {
    const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
    const providerObservation = readRuntimeProviderObservationProjection(metadata);
    const target = providerObservation.target;
    const assignedModelId = providerObservation.assignedModelId
        ?? providerObservation.modelId
        ?? readTrimmedString(target?.modelId)
        ?? readTrimmedString(metadata?.modelId);
    const compatibilityProfile = providerObservation.compatibilityProfile
        ?? readTrimmedString(target?.compatibilityProfile);
    const runtimeControl = readRuntimeControlProjection(metadata);
    return {
        ...requestTruth,
        ...(assignedModelId ? { assignedModelId } : {}),
        ...(compatibilityProfile ? { compatibilityProfile } : {}),
        ...(runtimeControl.stopless ? { stopless: runtimeControl.stopless } : {}),
    };
}
