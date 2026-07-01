/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request/response conversation store writes on the handler side.
 */
import { applySystemPromptOverride } from '../../../utils/system-prompt-loader.js';
import { captureResponsesRequestContextForRequest, clearResponsesConversationByRequestId, finalizeResponsesConversationRequestRetention, lookupResponsesContinuationByResponseId, materializeLatestResponsesContinuationByScope, recordResponsesResponseForRequest, resumeResponsesConversation, } from './runtime-integrations.js';
import { captureReqInboundResponsesContextSnapshot, planResponsesHandlerEntry, } from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../../../server/runtime/http-server/metadata-center/dualwrite-api.js';
const RESPONSES_PIPELINE_METADATA_WRITER = {
    module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
    symbol: 'buildResponsesPipelineMetadataForHttp',
    stage: 'MetaReq04RuntimeControlBound'
};
const RESPONSES_PIPELINE_CONTINUATION_WRITER = {
    module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
    symbol: 'buildResponsesPipelineMetadataForHttp',
    stage: 'MetaReq03ContinuationAttached'
};
export function prepareResponsesRequestBodyForHttp(payload, _runtimeMetadata) {
    const requestBodyMetadata = readRequestBodyMetadataForHttp(payload);
    const pipelineBody = stripRequestBodyMetadataForPipelineForHttp(payload);
    return {
        requestBodyMetadata,
        pipelineBody,
    };
}
export function buildResponsesPipelineMetadataForHttp(args) {
    const responsesResume = args.resumeMeta
        ? buildResponsesResumeControlForContinuationContextForHttp(args.resumeMeta)
        : undefined;
    const metadata = {
        clientRequestId: args.clientRequestId,
        clientStream: args.streamPlan.acceptsSse || undefined,
        clientHeaders: args.clientHeaders,
        clientConnectionState: args.clientConnectionState,
        ...(responsesResume ? { responsesResume } : {}),
    };
    MetadataCenter.attach(metadata);
    writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'streamIntent',
        value: args.streamPlan.inboundStream || args.streamPlan.outboundStream ? 'stream' : 'non_stream',
        writer: RESPONSES_PIPELINE_METADATA_WRITER,
        reason: 'responses handler stream intent'
    });
    writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'providerProtocol',
        value: 'openai-responses',
        writer: RESPONSES_PIPELINE_METADATA_WRITER,
        reason: 'responses handler provider protocol'
    });
    writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'clientAbort',
        value: readClientAbortSignalForHttp(args.clientConnectionState)?.aborted === true,
        writer: RESPONSES_PIPELINE_METADATA_WRITER,
        reason: 'responses handler client abort state'
    });
    if (args.resumeMeta) {
        if (responsesResume) {
            writeMetadataCenterSlot({
                target: metadata,
                family: 'continuation_context',
                key: 'responsesResume',
                value: responsesResume,
                writer: RESPONSES_PIPELINE_CONTINUATION_WRITER
            });
        }
    }
    return metadata;
}
function buildResponsesResumeControlForContinuationContextForHttp(resumeMeta) {
    const out = {};
    const copyString = (from, to = from) => {
        const value = resumeMeta[from];
        if (typeof value === 'string' && value.trim()) {
            out[to] = value.trim();
        }
    };
    const copyBoolean = (key) => {
        if (typeof resumeMeta[key] === 'boolean') {
            out[key] = resumeMeta[key];
        }
    };
    const copyNumber = (key) => {
        if (typeof resumeMeta[key] === 'number' && Number.isFinite(resumeMeta[key])) {
            out[key] = resumeMeta[key];
        }
    };
    copyString('responseId');
    copyString('restoredFromResponseId');
    copyString('previousRequestId');
    copyString('requestId');
    copyString('scopeKey');
    copyString('entryKind');
    copyString('continuationOwner');
    copyString('materializedMode');
    copyBoolean('restored');
    copyBoolean('materialized');
    copyNumber('deltaInputItems');
    copyNumber('toolOutputs');
    copyNumber('incomingInputItems');
    copyNumber('continuationDeltaItems');
    copyNumber('fullInputItems');
    return out;
}
export function buildResponsesConversationPortScopeForHttp(portContext) {
    const matchedPort = typeof portContext?.matchedPort === 'number'
        ? portContext.matchedPort
        : typeof portContext?.localPort === 'number'
            ? portContext.localPort
            : undefined;
    const routingPolicyGroup = typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()
        ? portContext.routingPolicyGroup.trim()
        : undefined;
    return {
        ...(typeof matchedPort === 'number' ? { matchedPort } : {}),
        ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
    };
}
export function planResponsesHandlerStreamForHttp(args) {
    const hasExplicitStream = typeof args.payload?.stream === 'boolean';
    const originalStream = args.payload?.stream === true;
    const outboundStream = typeof args.forceStream === 'boolean'
        ? args.forceStream
        : (hasExplicitStream ? originalStream : true);
    const inboundStream = outboundStream;
    return {
        originalStream,
        outboundStream,
        inboundStream,
        acceptsSse: args.acceptsSse,
        requestStartMeta: {
            inboundStream,
            outboundStream,
            clientAcceptsSse: args.acceptsSse,
            originalStream,
            type: args.payload?.type,
            timeoutMs: args.requestTimeoutMs
        }
    };
}
export function readResponsesSessionIdFromHttp(metadata) {
    const clientHeaders = metadata?.clientHeaders && typeof metadata.clientHeaders === 'object' && !Array.isArray(metadata.clientHeaders)
        ? metadata.clientHeaders
        : undefined;
    const candidates = [
        metadata?.session_id,
        metadata?.sessionId,
        clientHeaders?.session_id,
        clientHeaders?.sessionId,
        clientHeaders?.['session-id'],
        clientHeaders?.['x-session-id']
    ];
    for (const candidate of candidates) {
        const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}
export function readResponsesConversationIdFromHttp(metadata) {
    const clientHeaders = metadata?.clientHeaders && typeof metadata.clientHeaders === 'object' && !Array.isArray(metadata.clientHeaders)
        ? metadata.clientHeaders
        : undefined;
    const candidates = [
        metadata?.conversation_id,
        metadata?.conversationId,
        clientHeaders?.conversation_id,
        clientHeaders?.conversationId,
        clientHeaders?.['conversation-id'],
        clientHeaders?.['x-conversation-id']
    ];
    for (const candidate of candidates) {
        const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}
export function readRequestBodyMetadataForHttp(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }
    const raw = payload.metadata;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    try {
        return JSON.parse(JSON.stringify(raw));
    }
    catch {
        return { ...raw };
    }
}
export function stripRequestBodyMetadataForPipelineForHttp(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return payload;
    }
    const record = payload;
    if (!Object.prototype.hasOwnProperty.call(record, 'metadata')) {
        return payload;
    }
    const { metadata: _metadata, ...withoutMetadata } = record;
    return withoutMetadata;
}
export function readClientAbortSignalForHttp(clientConnectionState) {
    if (!clientConnectionState || typeof clientConnectionState !== 'object') {
        return undefined;
    }
    const abortSignalSymbol = Reflect.ownKeys(clientConnectionState).find((key) => typeof key === 'symbol' && key.description === 'routecodex.clientConnectionAbortSignal');
    if (!abortSignalSymbol) {
        return undefined;
    }
    const signal = Reflect.get(clientConnectionState, abortSignalSymbol);
    if (signal && typeof signal === 'object' && 'aborted' in signal) {
        return signal;
    }
    return undefined;
}
export function shouldPersistResponsesConversationForHttp(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return false;
    }
    const record = payload;
    if (record.store === true) {
        return true;
    }
    const previousResponseId = typeof record.previous_response_id === 'string' && record.previous_response_id.trim()
        ? record.previous_response_id.trim()
        : '';
    const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : [];
    return Boolean(previousResponseId && toolOutputs.length > 0);
}
export function readResponsesResponseIdFromHttp(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return undefined;
    const record = body;
    const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
        ? record.response
        : undefined;
    for (const candidate of [record.id, record.response_id, nested?.id]) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
    }
    return undefined;
}
export function finalizeResponsesHandlerPayloadForHttp(args) {
    const payload = args.payload;
    if (!args.isSubmitToolOutputs && args.outboundStream && payload.stream !== true) {
        payload.stream = true;
    }
    if (!args.isSubmitToolOutputs && args.entryEndpoint === '/v1/responses') {
        applySystemPromptOverride(args.entryEndpoint, payload);
    }
    return payload;
}
export function shouldManageResponsesConversationForHttp(entryEndpoint) {
    return entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs';
}
export function buildResponsesScopeContinuationExpiredErrorForHttp() {
    return {
        error: {
            message: 'Responses continuation expired or not found for local scope materialization',
            type: 'invalid_request_error',
            code: 'responses_continuation_expired',
        },
    };
}
export function buildResponsesResumeClientErrorForHttp(args) {
    return {
        status: typeof args.status === 'number' ? args.status : 422,
        body: {
            error: {
                message: typeof args.message === 'string' && args.message.trim()
                    ? args.message
                    : 'Unable to resume Responses conversation',
                type: 'invalid_request_error',
                code: typeof args.code === 'string' && args.code.trim()
                    ? args.code
                    : 'responses_resume_failed',
                origin: typeof args.origin === 'string' && args.origin.trim()
                    ? args.origin
                    : 'client',
            },
        },
    };
}
export function shouldProjectResponsesResumeClientErrorForHttp(args) {
    return typeof args.origin === 'string' && args.origin.trim() === 'client';
}
function isProviderOwnedSubmitToolOutputsResumePayload(payload) {
    const responseId = typeof payload.response_id === 'string' && payload.response_id.trim()
        ? payload.response_id.trim()
        : undefined;
    const toolOutputs = Array.isArray(payload.tool_outputs) ? payload.tool_outputs : [];
    return Boolean(responseId && toolOutputs.length > 0);
}
function isRelayMaterializedSubmitToolOutputsResumePayload(payload, resumeMeta) {
    if (!resumeMeta
        || typeof resumeMeta !== 'object'
        || Array.isArray(resumeMeta)
        || resumeMeta.continuationOwner !== 'relay') {
        return false;
    }
    const previousResponseId = typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
        ? payload.previous_response_id.trim()
        : undefined;
    const fullInput = Array.isArray(resumeMeta.fullInput) ? resumeMeta.fullInput : undefined;
    const hasInputHistory = Array.isArray(payload.input) && payload.input.length > 0;
    return Boolean(previousResponseId && hasInputHistory && fullInput && fullInput.length > 0);
}
async function buildCapturedRelayResumeRequestContextForHttp(args) {
    const payloadMetadata = args.payload.metadata && typeof args.payload.metadata === 'object' && !Array.isArray(args.payload.metadata)
        ? args.payload.metadata
        : undefined;
    const captured = await captureReqInboundResponsesContextSnapshot({
        rawRequest: args.payload,
        requestId: args.requestId,
        toolCallIdStyle: args.payload.toolCallIdStyle ?? payloadMetadata?.toolCallIdStyle,
    });
    const capturedInput = Array.isArray(captured.input) ? captured.input : [];
    const capturedToolsRaw = Array.isArray(captured.toolsRaw) ? captured.toolsRaw : [];
    const normalizedPayload = {
        ...args.payload,
        input: capturedInput,
    };
    if (capturedToolsRaw.length) {
        normalizedPayload.tools = capturedToolsRaw;
    }
    return {
        payload: normalizedPayload,
        context: {
            input: capturedInput,
            toolsRaw: capturedToolsRaw,
        },
        sessionId: readResponsesSessionIdFromHttp(args.metadata),
        conversationId: readResponsesConversationIdFromHttp(args.metadata),
        ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
        ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
    };
}
export async function buildResponsesRequestContextForHttp(args) {
    const payloadMetadata = args.payload.metadata && typeof args.payload.metadata === 'object' && !Array.isArray(args.payload.metadata)
        ? args.payload.metadata
        : undefined;
    const payloadForPersistence = stripRequestBodyMetadataForPipelineForHttp(args.payload);
    const relayResumeFullInput = Array.isArray(args.resumeMeta?.fullInput) ? args.resumeMeta.fullInput : undefined;
    const relayResumeTools = Array.isArray(args.resumeMeta?.restoredTools) ? args.resumeMeta.restoredTools : undefined;
    const relayOwnedSubmitToolOutputsResume = args.resumeMeta
        && typeof args.resumeMeta === 'object'
        && !Array.isArray(args.resumeMeta)
        && args.resumeMeta.continuationOwner === 'relay'
        && isProviderOwnedSubmitToolOutputsResumePayload(payloadForPersistence)
        && Array.isArray(relayResumeFullInput)
        && relayResumeFullInput.length > 0;
    const relayOwnedMaterializedSubmitToolOutputsResume = isRelayMaterializedSubmitToolOutputsResumePayload(payloadForPersistence, args.resumeMeta);
    if (relayOwnedSubmitToolOutputsResume) {
        const relayResumePayload = {
            ...payloadForPersistence,
            ...(typeof args.resumeMeta?.responseId === 'string' && args.resumeMeta.responseId.trim()
                ? { previous_response_id: args.resumeMeta.responseId.trim() }
                : {}),
            input: relayResumeFullInput,
            ...(relayResumeTools?.length ? { tools: relayResumeTools } : {}),
        };
        delete relayResumePayload.response_id;
        delete relayResumePayload.tool_outputs;
        return buildCapturedRelayResumeRequestContextForHttp({
            payload: relayResumePayload,
            requestId: args.requestId,
            metadata: args.metadata,
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
    }
    if (relayOwnedMaterializedSubmitToolOutputsResume) {
        return buildCapturedRelayResumeRequestContextForHttp({
            payload: {
                ...payloadForPersistence,
                input: relayResumeFullInput ?? [],
                ...(relayResumeTools?.length ? { tools: relayResumeTools } : {}),
            },
            requestId: args.requestId,
            metadata: args.metadata,
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
    }
    if (isProviderOwnedSubmitToolOutputsResumePayload(payloadForPersistence)) {
        const providerOwnedInput = Array.isArray(payloadForPersistence.input) && payloadForPersistence.input.length > 0
            ? payloadForPersistence.input
            : Array.isArray(payloadForPersistence.tool_outputs)
                ? payloadForPersistence.tool_outputs
                    .map((item) => {
                    if (!item || typeof item !== 'object' || Array.isArray(item)) {
                        return null;
                    }
                    const row = item;
                    const callId = (typeof row.call_id === 'string' && row.call_id.trim())
                        ? row.call_id.trim()
                        : ((typeof row.tool_call_id === 'string' && row.tool_call_id.trim())
                            ? row.tool_call_id.trim()
                            : ((typeof row.id === 'string' && row.id.trim())
                                ? row.id.trim()
                                : undefined));
                    if (!callId) {
                        return null;
                    }
                    return {
                        type: 'function_call_output',
                        call_id: callId,
                        output: typeof row.output === 'string' ? row.output : JSON.stringify(row.output ?? ''),
                    };
                })
                    .filter((item) => Boolean(item))
                : [];
        return {
            payload: {
                ...payloadForPersistence,
                ...(typeof payloadForPersistence.response_id === 'string' && payloadForPersistence.response_id.trim()
                    ? { previous_response_id: payloadForPersistence.response_id.trim() }
                    : {}),
                input: providerOwnedInput,
            },
            context: {
                input: providerOwnedInput,
            },
            sessionId: readResponsesSessionIdFromHttp(args.metadata),
            conversationId: readResponsesConversationIdFromHttp(args.metadata),
            ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
            ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
        };
    }
    const captured = await captureReqInboundResponsesContextSnapshot({
        rawRequest: args.payload,
        requestId: args.requestId,
        toolCallIdStyle: args.payload.toolCallIdStyle ?? payloadMetadata?.toolCallIdStyle,
    });
    const capturedInput = Array.isArray(captured.input) ? captured.input : [];
    const capturedToolsRaw = Array.isArray(captured.toolsRaw) ? captured.toolsRaw : [];
    const normalizedPayload = {
        ...payloadForPersistence,
        input: capturedInput,
    };
    if (capturedToolsRaw.length) {
        normalizedPayload.tools = capturedToolsRaw;
    }
    return {
        payload: normalizedPayload,
        context: {
            input: capturedInput,
            toolsRaw: capturedToolsRaw,
        },
        sessionId: readResponsesSessionIdFromHttp(args.metadata),
        conversationId: readResponsesConversationIdFromHttp(args.metadata),
        ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
        ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
    };
}
export async function prepareResponsesHandlerEntryForHttp(args) {
    const plannedEntry = await planResponsesHandlerEntry(args.payload, args.entryEndpoint, args.responseIdFromPath);
    const payload = (plannedEntry.payload ?? {});
    const isSubmitToolOutputs = plannedEntry.mode === 'submit_tool_outputs';
    let resumeMeta;
    let pipelineEntryEndpoint = args.entryEndpoint;
    if (args.responseIdFromPath && !payload.response_id) {
        payload.response_id = args.responseIdFromPath;
    }
    if (isSubmitToolOutputs) {
        const responseId = plannedEntry.responseId || args.responseIdFromPath;
        if (!responseId) {
            throw Object.assign(new Error('response_id is required for submit_tool_outputs'), {
                status: 400,
                code: 'bad_request',
                origin: 'client',
            });
        }
        const continuation = await lookupResponsesContinuationByResponseId(responseId, {
            entryKind: 'responses',
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
        if (continuation?.continuationOwner === 'direct') {
            resumeMeta = {
                responseId,
                restored: false,
                continuationOwner: 'direct',
                ...(continuation.providerKey ? { providerKey: continuation.providerKey } : {}),
            };
            pipelineEntryEndpoint = args.entryEndpoint;
            return {
                kind: 'ok',
                payload,
                pipelineEntryEndpoint,
                plannedEntryMode: plannedEntry.mode,
                isSubmitToolOutputs,
                resumeMeta,
            };
        }
        const resumeResult = await resumeResponsesConversation(responseId, payload, {
            requestId: args.requestId,
            entryKind: 'responses',
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
        // Relay-owned continuation is already materialized into a normal
        // /v1/responses payload; keep it on the mainline instead of letting
        // downstream provider/runtime layers reinterpret it as upstream-native
        // submit_tool_outputs.
        pipelineEntryEndpoint = '/v1/responses';
        return {
            kind: 'ok',
            payload: (resumeResult.payload ?? {}),
            pipelineEntryEndpoint,
            plannedEntryMode: plannedEntry.mode,
            isSubmitToolOutputs,
            resumeMeta: resumeResult.meta,
        };
    }
    const previousResponseId = typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
        ? payload.previous_response_id.trim()
        : undefined;
    if (args.entryEndpoint === '/v1/responses' && previousResponseId) {
        const continuation = await lookupResponsesContinuationByResponseId(previousResponseId, {
            entryKind: 'responses',
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
        if (continuation?.continuationOwner === 'relay' && plannedEntry.mode === 'scope_materialize') {
            const materialized = await materializeLatestResponsesContinuationByScope({
                payload,
                requestId: args.requestId,
                sessionId: args.sessionId,
                conversationId: args.conversationId,
                entryKind: 'responses',
                continuationOwner: 'relay',
                matchedPort: args.matchedPort,
                routingPolicyGroup: args.routingPolicyGroup,
            });
            if (!materialized) {
                return { kind: 'scope_continuation_expired' };
            }
            return {
                kind: 'ok',
                payload: (materialized.payload ?? {}),
                pipelineEntryEndpoint,
                plannedEntryMode: plannedEntry.mode,
                isSubmitToolOutputs,
                resumeMeta: materialized.meta,
            };
        }
        if (continuation?.continuationOwner === 'direct' || continuation?.continuationOwner === 'relay') {
            resumeMeta = {
                responseId: previousResponseId,
                restored: false,
                continuationOwner: continuation.continuationOwner,
                ...(continuation.providerKey ? { providerKey: continuation.providerKey } : {}),
                ...(continuation.requestId ? { previousRequestId: continuation.requestId } : {}),
            };
        }
    }
    if (plannedEntry.mode === 'scope_materialize') {
        const materialized = await materializeLatestResponsesContinuationByScope({
            payload,
            requestId: args.requestId,
            sessionId: args.sessionId,
            conversationId: args.conversationId,
            entryKind: 'responses',
            matchedPort: args.matchedPort,
            routingPolicyGroup: args.routingPolicyGroup,
        });
        if (!materialized) {
            return { kind: 'scope_continuation_expired' };
        }
        return {
            kind: 'ok',
            payload: (materialized.payload ?? {}),
            pipelineEntryEndpoint,
            plannedEntryMode: plannedEntry.mode,
            isSubmitToolOutputs,
            resumeMeta: materialized.meta,
        };
    }
    return {
        kind: 'ok',
        payload,
        pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta,
    };
}
export async function prepareResponsesHandlerRuntimeForHttp(args) {
    const streamPlan = planResponsesHandlerStreamForHttp({
        payload: args.payload,
        forceStream: args.forceStream,
        acceptsSse: args.acceptsSse,
        requestTimeoutMs: args.requestTimeoutMs,
    });
    const requestBodyMetadata = readRequestBodyMetadataForHttp(args.payload);
    const effectiveRequestMetadata = {
        ...(requestBodyMetadata ?? {}),
        ...(args.requestMetadata ?? {})
    };
    const sessionId = readResponsesSessionIdFromHttp(effectiveRequestMetadata);
    const conversationId = readResponsesConversationIdFromHttp(effectiveRequestMetadata);
    try {
        const preparedEntry = await prepareResponsesHandlerEntryForHttp({
            payload: args.payload,
            entryEndpoint: args.entryEndpoint,
            responseIdFromPath: args.responseIdFromPath,
            requestId: args.requestId,
            sessionId,
            conversationId,
            matchedPort: args.portScope?.matchedPort,
            routingPolicyGroup: args.portScope?.routingPolicyGroup,
        });
        if (preparedEntry.kind === 'scope_continuation_expired') {
            const clientError = buildResponsesScopeContinuationExpiredErrorForHttp();
            return {
                kind: 'client_error',
                status: 400,
                body: clientError,
                streamPlan,
            };
        }
        const payload = finalizeResponsesHandlerPayloadForHttp({
            payload: preparedEntry.payload,
            entryEndpoint: args.entryEndpoint,
            isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
            outboundStream: streamPlan.outboundStream,
        });
        const requestContext = await buildResponsesRequestContextForHttp({
            payload,
            requestId: args.requestId,
            metadata: effectiveRequestMetadata,
            resumeMeta: preparedEntry.resumeMeta,
            matchedPort: args.portScope?.matchedPort,
            routingPolicyGroup: args.portScope?.routingPolicyGroup,
        });
        return {
            kind: 'ok',
            payload: requestContext.payload,
            requestContext,
            pipelineEntryEndpoint: preparedEntry.pipelineEntryEndpoint,
            isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
            resumeMeta: preparedEntry.resumeMeta,
            streamPlan,
        };
    }
    catch (error) {
        const structured = error;
        const origin = typeof structured?.origin === 'string' ? structured.origin : undefined;
        if (!shouldProjectResponsesResumeClientErrorForHttp({ origin })) {
            throw error;
        }
        const status = typeof structured?.status === 'number' ? structured.status : undefined;
        const code = typeof structured?.code === 'string' ? structured.code : 'responses_resume_failed';
        const message = error instanceof Error ? error.message : 'Unable to resume Responses conversation';
        const clientError = buildResponsesResumeClientErrorForHttp({
            status,
            code,
            origin,
            message,
        });
        return {
            kind: 'client_error',
            status: clientError.status,
            body: clientError.body,
            streamPlan,
        };
    }
}
export async function captureResponsesRequestContextForHttp(args) {
    await captureResponsesRequestContextForRequest({
        ...args,
        entryKind: args.entryKind ?? 'responses',
    });
}
export function attachResponsesRequestContextToResultForHttp(args) {
    void args.requestContext;
    if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
        return args.resultMetadata;
    }
    return {
        ...(args.resultMetadata || {}),
    };
}
export async function recordResponsesResponseForHttp(args) {
    await recordResponsesResponseForRequest({
        ...args,
        entryKind: args.entryKind ?? 'responses',
    });
}
export async function seedResponsesToolCallResponseForHttp(args) {
    const responseId = readResponsesResponseIdFromHttp(args.body);
    const finishReason = deriveFinishReason(args.body);
    if (!responseId || finishReason !== 'tool_calls') {
        return;
    }
    const requestContext = args.requestContext;
    if (!requestContext?.payload || !requestContext?.context) {
        return;
    }
    await captureResponsesRequestContextForHttp({
        requestId: responseId,
        payload: requestContext.payload,
        context: requestContext.context,
        sessionId: requestContext.sessionId,
        conversationId: requestContext.conversationId,
        matchedPort: requestContext.matchedPort,
        routingPolicyGroup: requestContext.routingPolicyGroup,
        providerKey: args.providerKey
    });
    if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) {
        await recordResponsesResponseForHttp({
            requestId: responseId,
            response: args.body,
            providerKey: args.providerKey,
            matchedPort: requestContext.matchedPort,
            routingPolicyGroup: requestContext.routingPolicyGroup,
            sessionId: requestContext.sessionId,
            conversationId: requestContext.conversationId,
            ...(typeof args.routeHint === 'string' ? { routeHint: args.routeHint } : {})
        });
    }
}
export async function finalizeResponsesPipelineResultForHttp(args) {
    const nextMetadata = attachResponsesRequestContextToResultForHttp({
        entryEndpoint: args.entryEndpoint,
        resultMetadata: args.resultMetadata,
        requestContext: args.requestContext,
    });
    if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
        return nextMetadata;
    }
    await seedResponsesToolCallResponseForHttp({
        body: args.body,
        requestContext: args.requestContext,
        providerKey: args.providerKey,
        ...(typeof args.routeHint === 'string' ? { routeHint: args.routeHint } : {})
    });
    return nextMetadata;
}
export async function clearResponsesConversationByRequestIdForHttp(requestId) {
    await clearResponsesConversationByRequestId(requestId);
}
export async function clearResponsesConversationOnHandlerFailureForHttp(args) {
    if (!args.requestId || !args.requestId.trim()) {
        return;
    }
    await clearResponsesConversationByRequestIdForHttp(args.requestId);
}
export async function captureResponsesInboundToolHistoryErrorsampleForHttp(args) {
    const errorRecord = args.error && typeof args.error === 'object'
        ? args.error
        : undefined;
    const code = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
    if (code !== 'MALFORMED_REQUEST') {
        return;
    }
    const message = args.error instanceof Error ? args.error.message : String(args.error ?? '');
    const details = errorRecord && typeof errorRecord.details === 'object'
        ? errorRecord.details
        : undefined;
    if (!message.includes('Tool history contract violated')
        && !Boolean(details?.toolHistoryContractViolation)) {
        return;
    }
    await writeErrorsampleJson({
        group: 'payload-contract-error',
        kind: 'responses.inbound_tool_history_contract',
        payload: {
            kind: 'responses.inbound_tool_history_contract',
            timestamp: new Date().toISOString(),
            requestId: args.requestId,
            entryEndpoint: args.entryEndpoint,
            body: args.body,
            error: args.error && typeof args.error === 'object'
                ? {
                    name: args.error.name,
                    message: args.error.message,
                    code: args.error.code,
                    details: args.error.details
                }
                : { message: String(args.error ?? 'unknown_error') }
        }
    });
}
export async function finalizeResponsesConversationRequestRetentionForHttp(requestId, options) {
    await finalizeResponsesConversationRequestRetention(requestId, options);
}
