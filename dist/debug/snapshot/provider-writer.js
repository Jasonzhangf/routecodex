// feature_id: snapshot.stage_contract — orchestrator only
// Strategy split: provider-queue, provider-429, provider-sse, provider-errorsample
import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { coerceSnapshotPayloadForWrite, planSnapshotPayloadWrite } from '../../utils/snapshot-payload-guard.js';
import { writeUnifiedSnapshot } from './writer.js';
import { resetProviderSnapshotErrorBufferForTests, } from './buffer.js';
import { buildSnapshotPayload, resolveEndpoint, normalizeRequestId, normalizeProviderToken, logSnapshotNonBlockingError, } from './provider-utils.js';
import { MetadataCenter } from '../../server/runtime/http-server/metadata-center/metadata-center.js';
import { enqueueSnapshotPersist, __flushProviderSnapshotQueueForTests as flushProviderSnapshotQueueForTests, __resetProviderSnapshotQueueForTests as resetProviderSnapshotQueueForTests, } from './provider-queue.js';
import { shouldSuppressSnapshotFor429, schedule429ProviderSnapshotPurge, purge429ProviderSnapshotArtifacts, } from './provider-429.js';
import { setWriteProviderSnapshot, shouldCaptureProviderStreamSnapshots, attachProviderSseSnapshotStream, } from './provider-sse.js';
import { writeProviderErrorsample, writeProviderRetrySnapshot, writeRepairFeedbackSnapshot, } from './provider-errorsample.js';
export function __resetProviderSnapshotErrorBufferForTests() {
    resetProviderSnapshotErrorBufferForTests();
}
export async function __flushProviderSnapshotQueueForTests() {
    await flushProviderSnapshotQueueForTests();
}
export function __resetProviderSnapshotQueueForTests() {
    resetProviderSnapshotQueueForTests();
}
function isErrorPhase(phase) {
    return String(phase || '').trim().toLowerCase().includes('error');
}
function readEntryPortFromMetadataCenter(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }
    const metadataCenter = MetadataCenter.read(metadata);
    const requestTruthPortScope = metadataCenter?.readRequestTruth().portScope;
    if (typeof requestTruthPortScope !== 'string') {
        return undefined;
    }
    const parsed = Number.parseInt(requestTruthPortScope, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function resolveProviderSnapshotEntryPort(entryPort, metadata) {
    if (typeof entryPort === 'number' && Number.isFinite(entryPort) && entryPort > 0) {
        return Math.floor(entryPort);
    }
    return readEntryPortFromMetadataCenter(metadata);
}
function requireProviderSnapshotEntryPort(stage, entryPort, metadata) {
    const resolved = resolveProviderSnapshotEntryPort(entryPort, metadata);
    if (typeof resolved === 'number') {
        return resolved;
    }
    if (String(stage || '').trim().toLowerCase().startsWith('provider-') || String(stage || '').trim().toLowerCase().startsWith('client-')) {
        throw new Error(`[snapshot-writer] entryPort required for stage=${stage}`);
    }
    return resolved;
}
function buildProviderSnapshotPersistInput(options) {
    const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
    const stage = options.phase;
    const requestId = normalizeRequestId(options.requestId);
    const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
    const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
    const entryPort = requireProviderSnapshotEntryPort(stage, options.entryPort, options.metadata);
    const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
        stage,
        data: options.data,
        headers: options.headers,
        url: options.url,
        extraMeta: {
            ...(options.entryEndpoint ? { entryEndpoint: options.entryEndpoint } : {}),
            ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
            ...(options.providerKey ? { providerKey: options.providerKey } : {}),
            ...(options.providerId ? { providerId: options.providerId } : {}),
            ...(typeof entryPort === 'number' ? { entryPort, matchedPort: entryPort } : {})
        }
    }));
    return {
        endpoint,
        folder,
        stage,
        requestId,
        groupRequestId,
        providerToken,
        payload,
        entryPort,
        runtimeMetadata: options.metadata
    };
}
function buildClientOversizeSnapshotArtifact(args) {
    const artifact = buildSnapshotPayload({
        scope: 'client',
        stage: args.stage,
        data: undefined,
        headers: args.headers,
        url: args.endpoint,
        entryPort: args.entryPort,
        extraMeta: {
            entryEndpoint: args.endpoint,
            ...(typeof args.entryPort === 'number' ? { entryPort: args.entryPort, matchedPort: args.entryPort } : {})
        }
    });
    return {
        ...artifact,
        oversize: {
            kind: 'snapshot_payload_oversize',
            droppedBecause: 'payload_max_bytes_exceeded',
            estimatedBytes: args.estimatedBytes,
            maxBytes: args.maxBytes,
            summary: args.payloadSummary
        }
    };
}
async function persistProviderSnapshot(input, forceLocalDiskWriteWhenDisabled = false) {
    await writeUnifiedSnapshot({
        scope: 'provider',
        stage: input.stage,
        requestId: input.requestId,
        groupRequestId: input.groupRequestId,
        providerKey: input.providerToken || undefined,
        entryEndpoint: input.endpoint,
        entryPort: input.entryPort,
        data: input.payload,
        rawPayload: input.payload,
        runtimeMetadata: input.runtimeMetadata,
        verbosity: 'verbose',
        forceLocalDiskWriteWhenDisabled,
    });
}
export async function writeProviderSnapshot(options) {
    const stage = String(options.phase || '').trim();
    const entryPortForSnapshot = requireProviderSnapshotEntryPort(stage, options.entryPort, options.metadata);
    if (shouldSuppressSnapshotFor429(stage, options.data)) {
        const purgeInput = {
            entryEndpoint: options.entryEndpoint,
            requestId: options.requestId,
            clientRequestId: options.clientRequestId,
            entryPort: entryPortForSnapshot,
            providerKey: options.providerKey,
            providerId: options.providerId
        };
        await purge429ProviderSnapshotArtifacts(purgeInput);
        schedule429ProviderSnapshotPurge(purgeInput);
        return;
    }
    if (!shouldCaptureSnapshotStage(stage)) {
        return;
    }
    const snapshot = buildProviderSnapshotPersistInput(options);
    if (!runtimeFlags.snapshotsEnabled) {
        if (options.forceLocalDiskWriteWhenDisabled) {
            try {
                await persistProviderSnapshot(snapshot, true);
            }
            catch (error) {
                logSnapshotNonBlockingError(`forceLocalDiskWrite:${snapshot.stage}`, error);
            }
            return;
        }
        if (isErrorPhase(snapshot.stage)) {
            try {
                await writeProviderErrorsample(snapshot);
            }
            catch (error) {
                logSnapshotNonBlockingError(`writeProviderErrorsample:${snapshot.stage}`, error);
            }
        }
        return;
    }
    enqueueSnapshotPersist(snapshot);
}
export { shouldCaptureProviderStreamSnapshots, attachProviderSseSnapshotStream, writeProviderRetrySnapshot, writeRepairFeedbackSnapshot, };
export async function writeClientSnapshot(options) {
    if (!runtimeFlags.snapshotsEnabled) {
        return;
    }
    if (!shouldCaptureSnapshotStage('client-request')) {
        return;
    }
    try {
        const stage = 'client-request';
        const { endpoint } = resolveEndpoint(options.entryEndpoint);
        const requestId = normalizeRequestId(options.requestId);
        const groupRequestIdCandidate = options.metadata && typeof options.metadata === 'object' && typeof options.metadata.clientRequestId === 'string'
            ? options.metadata.clientRequestId
            : undefined;
        const groupRequestId = normalizeRequestId(groupRequestIdCandidate || requestId);
        const providerToken = normalizeProviderToken(options.providerKey || '');
        const metadataSnapshot = options.metadata && typeof options.metadata === 'object'
            ? options.metadata
            : undefined;
        const entryPort = requireProviderSnapshotEntryPort('client-request', undefined, metadataSnapshot);
        const snapshotPayload = typeof options.rawBodyText === 'string'
            ? options.rawBodyText
            : {
                body: options.body,
                metadata: metadataSnapshot || {}
            };
        const builtPayload = buildSnapshotPayload({
            scope: 'client',
            stage,
            data: snapshotPayload,
            headers: options.headers,
            url: endpoint,
            entryPort,
            extraMeta: {
                entryEndpoint: endpoint,
                ...(typeof entryPort === 'number' ? { entryPort, matchedPort: entryPort } : {}),
                stream: options.metadata?.stream,
                userAgent: options.metadata?.userAgent
            }
        });
        const payloadDecision = planSnapshotPayloadWrite(stage, builtPayload);
        const payload = payloadDecision.kind === 'full'
            ? payloadDecision.payload
            : buildClientOversizeSnapshotArtifact({
                stage,
                endpoint,
                entryPort,
                headers: options.headers,
                payloadSummary: payloadDecision.summary,
                estimatedBytes: payloadDecision.estimatedBytes,
                maxBytes: payloadDecision.maxBytes
            });
        await writeUnifiedSnapshot({
            scope: 'client',
            stage,
            requestId,
            groupRequestId,
            providerKey: providerToken || undefined,
            entryEndpoint: options.entryEndpoint,
            entryPort,
            data: payload,
            rawPayload: payload,
            runtimeMetadata: metadataSnapshot,
            verbosity: 'verbose',
        });
    }
    catch (error) {
        logSnapshotNonBlockingError('writeClientSnapshot', error);
        throw error;
    }
}
// Wire SSE module to use writeProviderSnapshot
setWriteProviderSnapshot(writeProviderSnapshot);
//# sourceMappingURL=provider-writer.js.map