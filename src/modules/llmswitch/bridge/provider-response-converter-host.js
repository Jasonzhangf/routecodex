import { requireCoreDist } from './module-loader.js';
import { recordResponsesResponse, finalizeResponsesConversationRequestRetention, } from './responses-conversation-store-host.js';
function requireModuleFn(module, name, label) {
    const fn = module[name];
    if (typeof fn !== 'function') {
        throw new Error(`[provider-response-converter-host] ${label}.${String(name)} not available`);
    }
    return fn;
}
function requireCoreModuleFn(subpath, name, label) {
    return (...args) => {
        const module = requireCoreDist(subpath);
        const fn = requireModuleFn(module, name, label);
        return fn(...args);
    };
}
const executeHubPipelineWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol', 'executeHubPipelineWithNative', 'native protocol');
const buildProviderResponseMetadataSnapshotWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol', 'buildProviderResponseMetadataSnapshotWithNative', 'native protocol');
const normalizeProviderResponseEffectPlanWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol', 'normalizeProviderResponseEffectPlanWithNative', 'native protocol');
const resolveProviderProtocolWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol', 'resolveProviderProtocolWithNative', 'native protocol');
const publishResponsesRecordPlanWithNative = requireCoreModuleFn('native/router-hotpath/native-shared-conversion-semantics', 'publishResponsesRecordPlanWithNative', 'native shared semantics');
const ensureRuntimeMetadata = requireCoreModuleFn('conversion/runtime-metadata', 'ensureRuntimeMetadata', 'runtime metadata');
const planChatProcessSessionUsage = requireCoreModuleFn('native/router-hotpath/native-virtual-router-routing-state', 'planChatProcessSessionUsage', 'native routing state');
const buildReadableFromSseFrames = requireCoreModuleFn('native/router-hotpath/native-sse-runtime', 'buildReadableFromSseFrames', 'native sse runtime');
const buildSseFramesFromJsonWithNative = requireCoreModuleFn('native/router-hotpath/native-sse-runtime', 'buildSseFramesFromJsonWithNative', 'native sse runtime');
const buildProviderSseStreamReadErrorDescriptorWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-resp-semantics', 'buildProviderSseStreamReadErrorDescriptorWithNative', 'native resp semantics');
const materializeProviderResponseSsePayloadWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-resp-semantics', 'materializeProviderResponseSsePayloadWithNative', 'native resp semantics');
const applyNativeRuntimeControlWritePlan = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'applyNativeRuntimeControlWritePlan', 'metadata writer');
const projectNativeMetadataWritePlanToRuntimeControlWritePlan = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'projectNativeMetadataWritePlanToRuntimeControlWritePlan', 'metadata writer');
const readBoundMetadataCenter = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'readBoundMetadataCenter', 'metadata writer');
const readContinuationContextFromBoundMetadataCenter = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'readContinuationContextFromBoundMetadataCenter', 'metadata writer');
const readRequestTruthFromBoundMetadataCenter = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'readRequestTruthFromBoundMetadataCenter', 'metadata writer');
const readRuntimeControlFromBoundMetadataCenter = requireCoreModuleFn('conversion/hub/metadata-center-runtime-control-writer', 'readRuntimeControlFromBoundMetadataCenter', 'metadata writer');
const resolveProviderResponseContextHelpersWithNative = requireCoreModuleFn('native/router-hotpath/native-hub-pipeline-resp-semantics', 'resolveProviderResponseContextHelpersWithNative', 'native resp semantics');
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function asRecord(value) {
    return isRecord(value) ? value : undefined;
}
function normalizeRecordPayload(payload) {
    if (isRecord(payload)) {
        return payload;
    }
    if (typeof payload === 'string' && payload.trim()) {
        try {
            const parsed = JSON.parse(payload);
            if (isRecord(parsed)) {
                return parsed;
            }
        }
        catch {
            return {};
        }
    }
    return {};
}
function recordStage(recorder, stageId, payload) {
    if (!recorder) {
        return;
    }
    try {
        recorder.record(stageId, normalizeRecordPayload(payload));
    }
    catch (error) {
        console.warn('[hub-pipeline] recordStage failed:', error instanceof Error ? error.message : String(error));
    }
}
function resolveProviderResponseContextSignals(context, entryEndpoint) {
    const resolved = resolveProviderResponseContextHelpersWithNative({
        context,
        legacyFollowupMarkerRaw: null,
        entryEndpoint,
        toolSurfaceModeRaw: String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '')
    });
    if (!readString(resolved.clientFacingRequestId)) {
        throw new Error('Rust provider response context helper returned no client-facing request id');
    }
    return { clientProtocol: resolved.clientProtocol };
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readProviderResponseRequestId(context) {
    const requestId = readString(context.requestId);
    if (!requestId) {
        throw new Error('Provider response conversion requires context.requestId');
    }
    return requestId;
}
function readMetadataCenterSnapshotForRust(context) {
    const contextRecord = context;
    const direct = asRecord(contextRecord.metadataCenterSnapshot);
    const nestedMetadata = asRecord(contextRecord.metadata);
    const snapshotPlan = buildProviderResponseMetadataSnapshotWithNative({
        hasBoundMetadataCenter: Boolean(readBoundMetadataCenter(contextRecord)),
        requestTruth: readRequestTruthFromBoundMetadataCenter(contextRecord),
        continuationContext: readContinuationContextFromBoundMetadataCenter(contextRecord),
        runtimeControl: readRuntimeControlFromBoundMetadataCenter(contextRecord),
        directMetadataCenterSnapshot: direct ?? null,
        nestedMetadataCenterSnapshot: nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null,
    });
    return snapshotPlan.metadataCenterSnapshot ?? null;
}
function writeRustStopGatewayContextToMetadataCenter(args) {
    applyNativeRuntimeControlWritePlan({
        metadata: args.metadata,
        runtimeControl: { stopGatewayContext: args.stopGatewayContext },
        writer: args.writer,
        reason: args.reason
    });
    ensureRuntimeMetadata(args.metadata).stopGatewayContext = args.stopGatewayContext;
}
function runProviderResponseRustHubPipeline(nativeOptions) {
    const nativeResponsePlan = executeHubPipelineWithNative(nativeOptions);
    if (!nativeResponsePlan.success) {
        const code = nativeResponsePlan.error?.code ?? 'hub_pipeline_response_native_failed';
        const message = nativeResponsePlan.error?.message ?? 'Rust HubPipeline response path failed';
        throw new Error(`Rust HubPipeline response path failed: ${code}: ${message}`);
    }
    if (!nativeResponsePlan.payload || typeof nativeResponsePlan.payload !== 'object') {
        throw new Error('Rust HubPipeline response path returned no payload');
    }
    return nativeResponsePlan;
}
function emitNativeHubPipelineDiagnosticAlarms(args) {
    for (const diagnostic of args.diagnostics) {
        const details = isRecord(diagnostic.details) ? diagnostic.details : null;
        const alarm = readString(details?.alarm);
        if (!alarm) {
            continue;
        }
        try {
            console.warn(`[hub-pipeline][alarm] ${alarm} requestId=${args.requestId} details=${JSON.stringify(details)}`);
        }
        catch {
            console.warn(`[hub-pipeline][alarm] ${alarm} requestId=${args.requestId}`);
        }
    }
}
function executeProviderResponseNativeOutboundEffects(args) {
    const rawPayload = args.nativeResponsePlan.payload;
    const effects = args.nativeResponsePlan.effectPlan.effects;
    if (!Array.isArray(effects)) {
        throw new Error('Rust HubPipeline response path returned malformed effect plan');
    }
    emitNativeHubPipelineDiagnosticAlarms({
        requestId: args.nativeResponsePlan.requestId,
        diagnostics: args.nativeResponsePlan.diagnostics
    });
    const normalizedEffects = normalizeProviderResponseEffectPlanWithNative({ effects });
    const runtimeEffects = normalizedEffects;
    args.context.__nativeResponsePlan = {
        payload: rawPayload,
        effectPlan: { effects },
        runtimeEffects,
        diagnostics: args.nativeResponsePlan.diagnostics
    };
    return { rawPayload, runtimeEffects };
}
async function executeProviderResponseNativeServertoolEffects(args) {
    if (!Array.isArray(args.runtimeEffects.servertoolRuntimeActions)) {
        throw new Error('Rust HubPipeline response path returned malformed servertool runtime actions');
    }
    const servertoolRuntimeActions = args.runtimeEffects.servertoolRuntimeActions;
    if (servertoolRuntimeActions.length > 0) {
        const firstAction = servertoolRuntimeActions.find(isRecord);
        const stopGateway = isRecord(firstAction?.stopGateway) ? firstAction.stopGateway : undefined;
        if (stopGateway) {
            writeRustStopGatewayContextToMetadataCenter({
                metadata: args.context,
                stopGatewayContext: stopGateway,
                writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
                reason: 'rust stop gateway control signal'
            });
        }
        throw new Error('Rust HubPipeline returned unsupported servertool runtime actions; server-side tool execution has been removed and CLI-owned tools must be projected by Rust');
    }
    return { payload: args.payload, stage: 'unchanged' };
}
function executeProviderResponseNativeRuntimeStateEffect(args) {
    if (args.runtimeEffects.stoplessMetadataCenterWrite) {
        const writePlan = projectNativeMetadataWritePlanToRuntimeControlWritePlan(args.runtimeEffects.stoplessMetadataCenterWrite);
        if (writePlan.runtimeControl) {
            applyNativeRuntimeControlWritePlan({
                metadata: args.context,
                runtimeControl: writePlan.runtimeControl,
                writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
                reason: 'rust response chatprocess runtime control'
            });
        }
    }
    const runtimeStateWrite = isRecord(args.runtimeEffects.runtimeStateWrite) ? args.runtimeEffects.runtimeStateWrite : null;
    const metadataCenterSnapshot = {
        requestTruth: readRequestTruthFromBoundMetadataCenter(args.context),
        runtimeControl: readRuntimeControlFromBoundMetadataCenter(args.context),
    };
    const plan = publishResponsesRecordPlanWithNative({
        requestId: args.requestId,
        response: args.response,
        context: metadataCenterSnapshot,
        runtimeStateWrite: runtimeStateWrite ?? null,
        entryEndpoint: args.entryEndpoint,
    });
    if (plan.recordArgs) {
        recordResponsesResponse({
            requestId: plan.recordArgs.requestId,
            response: plan.recordArgs.response,
            ...(plan.recordArgs.sessionId ? { sessionId: plan.recordArgs.sessionId } : {}),
            ...(plan.recordArgs.conversationId ? { conversationId: plan.recordArgs.conversationId } : {}),
            ...(plan.recordArgs.providerKey ? { providerKey: plan.recordArgs.providerKey } : {}),
            entryKind: 'responses',
            continuationOwner: 'relay',
            matchedPort: plan.recordArgs.matchedPort,
            ...(plan.recordArgs.routingPolicyGroup ? { routingPolicyGroup: plan.recordArgs.routingPolicyGroup } : {}),
            allowScopeContinuation: true,
            ...(plan.recordArgs.routeHint ? { routeHint: plan.recordArgs.routeHint } : {}),
        });
    }
    if (plan.finalizeArgs) {
        finalizeResponsesConversationRequestRetention(plan.finalizeArgs.requestId, { keepForSubmitToolOutputs: plan.finalizeArgs.keepForSubmitToolOutputs });
    }
    if (plan.usageArgs) {
        planChatProcessSessionUsage({
            context: args.context,
            usage: plan.usageArgs.usage
        });
    }
}
function readProviderResponseNativeStreamPipe(args) {
    const streamPipe = isRecord(args.runtimeEffects.streamPipe)
        ? args.runtimeEffects.streamPipe
        : null;
    if (!streamPipe) {
        return null;
    }
    const codec = readString(streamPipe.codec);
    const requestId = readString(streamPipe.requestId);
    const payload = isRecord(streamPipe.payload) ? streamPipe.payload : null;
    if (!codec || !requestId || !payload) {
        throw new Error('Rust HubPipeline response path returned malformed stream pipe effect');
    }
    return { codec: codec, requestId, payload };
}
async function materializeProviderResponseSsePayload(payload) {
    const stream = extractProviderResponseSseStream(payload);
    let streamBodyText;
    if (stream) {
        try {
            streamBodyText = await readProviderResponseSseStreamText(stream);
        }
        catch (error) {
            const source = error;
            const descriptor = buildProviderSseStreamReadErrorDescriptorWithNative({
                message: error instanceof Error ? error.message : String(error ?? 'unknown'),
                ...(typeof source?.code === 'string' ? { code: source.code } : {}),
                ...(typeof source?.upstreamCode === 'string' ? { upstreamCode: source.upstreamCode } : {})
            });
            const wrapped = new Error(descriptor.message);
            wrapped.code = descriptor.code;
            wrapped.upstreamCode = descriptor.upstreamCode;
            wrapped.statusCode = descriptor.statusCode;
            wrapped.retryable = descriptor.retryable;
            wrapped.requestExecutorProviderErrorStage = descriptor.requestExecutorProviderErrorStage;
            throw wrapped;
        }
    }
    return materializeProviderResponseSsePayloadWithNative({
        payload,
        ...(streamBodyText !== undefined ? { streamBodyText } : {})
    });
}
function extractProviderResponseSseStream(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }
    const record = payload;
    const direct = record.sseStream;
    if (direct && typeof direct.pipe === 'function') {
        return direct;
    }
    const data = record.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const nested = data;
        const nestedStream = nested.sseStream;
        if (nestedStream && typeof nestedStream.pipe === 'function') {
            return nestedStream;
        }
    }
    return undefined;
}
async function readProviderResponseSseStreamText(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}
export async function convertProviderResponse(options) {
    const requestId = readProviderResponseRequestId(options.context);
    const metadataCenterSnapshot = readMetadataCenterSnapshotForRust(options.context);
    const providerProtocol = resolveProviderProtocolWithNative({
        metadataCenterSnapshot
    }).providerProtocol;
    // Step 1: Materialize provider SSE payload via canonical Rust owner.
    const providerResponseMaterialized = await materializeProviderResponseSsePayload(options.providerResponse);
    // Step 2: Run Rust HubPipeline response path (normalize, govern, outbound)
    const nativeOptions = {
        config: {},
        request: {
            requestId,
            endpoint: options.entryEndpoint,
            entryEndpoint: options.entryEndpoint,
            providerProtocol,
            payload: providerResponseMaterialized,
            metadata: {
                ...options.context,
                clientProtocol: resolveProviderResponseContextSignals(options.context, options.entryEndpoint).clientProtocol,
                entryEndpoint: options.entryEndpoint,
                stream: options.wantsStream
            },
            ...(metadataCenterSnapshot ? { metadataCenterSnapshot } : {}),
            stream: options.wantsStream,
            processMode: 'chat',
            direction: 'response',
            stage: 'outbound'
        }
    };
    const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);
    // Step 3: Plan orchestration v2 — SSE materialize, usage, servertool plan, stream pipe, metadata write
    const outboundEffect = executeProviderResponseNativeOutboundEffects({
        context: options.context,
        nativeResponsePlan,
    });
    // Step 4: Reject retired server-side tool runtime actions.
    const respProcessEffect = await executeProviderResponseNativeServertoolEffects({
        payload: outboundEffect.rawPayload,
        runtimeEffects: outboundEffect.runtimeEffects,
        context: options.context,
        requestId,
        entryEndpoint: options.entryEndpoint,
        providerProtocol,
        stageRecorder: options.stageRecorder
    });
    let hubRespOutbound04ClientSemantic;
    hubRespOutbound04ClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'
        ? respProcessEffect.payload
        : outboundEffect.rawPayload;
    // Step 5: Apply metadata write plan
    executeProviderResponseNativeRuntimeStateEffect({
        context: options.context,
        entryEndpoint: options.entryEndpoint,
        requestId,
        response: hubRespOutbound04ClientSemantic,
        runtimeEffects: outboundEffect.runtimeEffects,
    });
    // Step 7: Stream or body-only response
    const streamPipe = readProviderResponseNativeStreamPipe({
        runtimeEffects: outboundEffect.runtimeEffects
    });
    if (!streamPipe) {
        recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
        recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
            passthrough: false,
            protocol: 'native-effect-plan',
            payload: hubRespOutbound04ClientSemantic
        });
        return { body: hubRespOutbound04ClientSemantic };
    }
    const streamClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'
        ? hubRespOutbound04ClientSemantic
        : streamPipe.payload;
    hubRespOutbound04ClientSemantic = streamClientSemantic;
    const sseCodec = streamPipe.codec;
    const frameResult = buildSseFramesFromJsonWithNative({
        protocol: sseCodec,
        response: hubRespOutbound04ClientSemantic,
        requestId,
        model: "",
    });
    const stream = buildReadableFromSseFrames(frameResult.frames);
    recordStage(options.stageRecorder, 'chat_process.resp.stage9.client_remap', hubRespOutbound04ClientSemantic);
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
        passthrough: false,
        protocol: streamPipe.codec,
        payload: hubRespOutbound04ClientSemantic
    });
    return {
        sseStream: stream,
        body: hubRespOutbound04ClientSemantic,
        format: streamPipe.codec
    };
}
//# sourceMappingURL=provider-response-converter-host.js.map
