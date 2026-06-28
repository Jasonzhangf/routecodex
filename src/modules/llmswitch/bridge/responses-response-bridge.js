import { createResponsesJsonToSseConverter, importCoreDist, isToolCallContinuationResponseNative, rebindResponsesConversationRequestId, requireCoreDist, } from './index.js';
import { clearResponsesConversationByRequestId, } from './runtime-integrations.js';
import { buildResponsesPayloadFromChatNative, projectResponsesClientPayloadForClientNative, } from './native-exports.js';
import { normalizeUsage } from '../../../server/runtime/http-server/executor/usage-aggregator.js';
import { readRuntimeRequestTruthIdentifiers, } from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';
import { stripInternalKeysDeep } from '../../../utils/strip-internal-keys.js';
export function resolveResponsesRequestContextForHttp(args) {
    void args.metadata;
    return args.fallback;
}
function isChatCompletionsEndpointForHttp(entryEndpoint) {
    return typeof entryEndpoint === 'string' && entryEndpoint.toLowerCase().includes('/v1/chat/completions');
}
function sanitizeNumericUsageFieldForHttp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
function resolveNormalizedChatUsageForHttp(body, options) {
    if (!isChatCompletionsEndpointForHttp(options.entryEndpoint)) {
        return {};
    }
    const record = body && typeof body === 'object' && !Array.isArray(body)
        ? body
        : undefined;
    const rawUsage = record?.usage;
    const normalizedFromBody = normalizeUsage(rawUsage);
    const normalizedFromFallback = normalizeUsage(options.usageFallback);
    const normalized = normalizedFromBody ?? normalizedFromFallback;
    if (!normalized) {
        return {};
    }
    const usageSource = normalizedFromBody ? 'body' : 'usage_log';
    const usageRecord = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
        ? { ...rawUsage }
        : {};
    const promptTokens = sanitizeNumericUsageFieldForHttp(normalized.prompt_tokens);
    const completionTokens = sanitizeNumericUsageFieldForHttp(normalized.completion_tokens);
    let totalTokens = sanitizeNumericUsageFieldForHttp(normalized.total_tokens);
    if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
        totalTokens = promptTokens + completionTokens;
    }
    if (promptTokens !== undefined) {
        usageRecord.input_tokens = promptTokens;
        usageRecord.prompt_tokens = promptTokens;
    }
    if (completionTokens !== undefined) {
        usageRecord.output_tokens = completionTokens;
        usageRecord.completion_tokens = completionTokens;
    }
    if (totalTokens !== undefined) {
        usageRecord.total_tokens = totalTokens;
    }
    return { usage: usageRecord, source: usageSource };
}
function asRecordForHttp(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';
function summarizeDebugToolsForHttp(tools) {
    const list = Array.isArray(tools) ? tools : [];
    return {
        count: list.length,
        names: list.map((tool) => {
            if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
                return 'unknown';
            }
            const row = tool;
            const directName = typeof row.name === 'string' ? row.name.trim() : '';
            if (directName) {
                return directName;
            }
            const fn = row.function && typeof row.function === 'object' && !Array.isArray(row.function)
                ? row.function
                : undefined;
            const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
            return fnName || 'unknown';
        }),
    };
}
export function buildResponsesRequestLogContextForHttp(args) {
    const metadata = asRecordForHttp(args.metadata);
    const usageLogInfo = asRecordForHttp(args.usageLogInfo);
    const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
    return {
        logSessionColorKey: usageLogInfo.logSessionColorKey ?? metadata.logSessionColorKey,
        clientTmuxSessionId: usageLogInfo.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
        client_tmux_session_id: usageLogInfo.client_tmux_session_id ?? metadata.client_tmux_session_id,
        tmuxSessionId: usageLogInfo.tmuxSessionId ?? metadata.tmuxSessionId,
        tmux_session_id: usageLogInfo.tmux_session_id ?? metadata.tmux_session_id,
        rccSessionClientTmuxSessionId: usageLogInfo.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
        rcc_session_client_tmux_session_id: usageLogInfo.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
        sessionId: usageLogInfo.sessionId ?? requestTruth.sessionId,
        session_id: usageLogInfo.session_id ?? requestTruth.sessionId,
        conversationId: usageLogInfo.conversationId ?? requestTruth.conversationId,
        conversation_id: usageLogInfo.conversation_id ?? requestTruth.conversationId
    };
}
export function normalizeChatUsagePayloadForHttp(body, options) {
    if (!isChatCompletionsEndpointForHttp(options.entryEndpoint)) {
        return { payload: body, normalized: false };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { payload: body, normalized: false };
    }
    const record = body;
    const resolved = resolveNormalizedChatUsageForHttp(body, options);
    if (!resolved.usage) {
        return { payload: body, normalized: false };
    }
    return {
        payload: {
            ...record,
            usage: resolved.usage
        },
        normalized: true,
        source: resolved.source
    };
}
export function shouldDispatchResponsesSseToClientForHttp(args) {
    return args.forceSSE;
}
export function buildClientSseKeepaliveFrameForHttp(entryEndpoint) {
    const commentFrame = ': keepalive\n\n';
    return commentFrame;
}
export function shouldClearResponsesConversationOnClientCloseForHttp(args) {
    return args.closeBeforeStreamEnd && args.entryEndpoint === '/v1/responses';
}
export function shouldClearResponsesConversationOnFailureForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses'
        && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
        return false;
    }
    if (args.phase === 'sse_stream_error' || args.phase === 'sse_incomplete') {
        return true;
    }
    return args.status >= 400;
}
export function resolveResponsesConversationClearReasonForHttp(phase) {
    switch (phase) {
        case 'sse_stream_error':
            return 'sse-stream-error';
        case 'sse_incomplete':
            return 'sse-incomplete';
        case 'json_empty':
            return 'json-empty-error';
        case 'json':
            return 'json-error';
    }
}
function isDirectResponsesToolCallContinuationForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses'
        && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
        return false;
    }
    return isToolCallContinuationResponseNative(args.responseBody);
}
export function planResponsesContinuationCloseActionForHttp(args) {
    const isToolCallContinuation = isDirectResponsesToolCallContinuationForHttp({
        entryEndpoint: args.entryEndpoint,
        responseBody: args.probe,
    });
    if (args.requestContextPresent && isToolCallContinuation) {
        return {
            action: 'persist_continuation',
            keepForSubmitToolOutputs: true,
        };
    }
    return {
        action: 'clear_abandoned',
        keepForSubmitToolOutputs: false,
    };
}
export async function rebindResponsesConversationRequestIdForHttp(oldId, newId) {
    await rebindResponsesConversationRequestId(oldId, newId);
}
export async function clearResponsesConversationRequestIdsForHttp(args) {
    const ids = [];
    const add = (value) => {
        if (typeof value !== 'string')
            return;
        const trimmed = value.trim();
        if (!trimmed || ids.includes(trimmed))
            return;
        ids.push(trimmed);
    };
    add(args.requestLabel);
    add(args.responseId);
    if (Array.isArray(args.timingRequestIds)) {
        for (const id of args.timingRequestIds)
            add(id);
    }
    for (const requestId of ids) {
        await clearResponsesConversationByRequestId(requestId).catch((error) => {
            args.onNonBlockingError?.(`responses-conversation-clear-${args.reason}:${requestId}`, error);
        });
    }
}
let cachedChatJsonToSseConverterFactory = null;
export async function createChatJsonToSseConverterForHttp() {
    if (!cachedChatJsonToSseConverterFactory) {
        const mod = await importResponsesHandlerCoreDist('sse/json-to-sse/index');
        const Ctor = mod.ChatJsonToSseConverter;
        if (typeof Ctor !== 'function') {
            throw new Error('[handler-response] ChatJsonToSseConverter not available');
        }
        cachedChatJsonToSseConverterFactory = () => new Ctor();
    }
    return cachedChatJsonToSseConverterFactory();
}
export function shouldReprojectRelayResponsesSseForHttp(args) {
    if (!args.hasSseStream) {
        return false;
    }
    const entry = String(args.entryEndpoint || '').trim().toLowerCase();
    if (entry !== '/v1/responses' && entry !== '/v1/responses.submit_tool_outputs') {
        return false;
    }
    return args.continuationOwner !== 'direct';
}
export async function resolveRelayResponsesClientSseStreamForHttp(args) {
    if (!shouldReprojectRelayResponsesSseForHttp({
        entryEndpoint: args.entryEndpoint,
        continuationOwner: args.continuationOwner,
        hasSseStream: args.sseStream !== undefined,
    })) {
        return args.sseStream;
    }
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
        throw new Error(`[server.response_projection] relay /v1/responses SSE requires standardized response body (requestId=${args.requestId})`);
    }
    const converter = await (args.createConverter ?? createResponsesJsonToSseConverter)();
    return await converter.convertResponseToJsonToSse(args.body, {
        requestId: args.requestId,
    });
}
export function buildResponsesSseErrorPayloadForHttp(args) {
    const payloadError = {
        ...(args.error ?? {}),
        message: args.message,
        code: args.code,
        request_id: typeof args.error?.request_id === 'string' && args.error.request_id.trim()
            ? args.error.request_id.trim()
            : args.requestLabel,
    };
    return {
        type: 'error',
        status: args.status,
        error: payloadError,
    };
}
export function buildResponsesStructuredSseErrorPayloadForHttp(args) {
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
        return null;
    }
    const record = args.body;
    const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
        ? record.error
        : undefined;
    if (!error) {
        return null;
    }
    const message = typeof error.message === 'string' && error.message.trim()
        ? error.message
        : 'Upstream provider error';
    const code = typeof error.code === 'string' && error.code.trim()
        ? error.code
        : 'HTTP_HANDLER_ERROR';
    return buildResponsesSseErrorPayloadForHttp({
        requestLabel: args.requestLabel,
        status: args.status,
        message,
        code,
        error,
    });
}
export function buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel, status = 502) {
    return buildResponsesSseErrorPayloadForHttp({
        requestLabel,
        status,
        message: 'SSE stream missing from pipeline result',
        code: 'sse_bridge_error',
    });
}
export function buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel) {
    return buildResponsesSseErrorPayloadForHttp({
        requestLabel,
        status: 502,
        message: 'stream closed before response.completed',
        code: 'upstream_stream_incomplete',
    });
}
export async function prepareResponsesJsonBodyForSseBridgeForHttp(args) {
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
        return null;
    }
    const record = args.body;
    const isResponsesEndpoint = args.entryEndpoint === '/v1/responses'
        || args.entryEndpoint === '/v1/responses.submit_tool_outputs';
    if (isResponsesEndpoint
        && (record.object === 'response'
            || typeof record.output === 'object'
            || typeof record.status === 'string')) {
        return record;
    }
    if (args.entryEndpoint !== '/v1/responses' || record.object !== 'chat.completion') {
        return null;
    }
    return await buildResponsesPayloadFromChatForHttp(args.body, {
        requestId: args.requestLabel
    });
}
export function normalizeResponsesJsonBodyForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses') {
        return Promise.resolve(args.body);
    }
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
        return Promise.resolve(args.body);
    }
    if (args.body.object !== 'chat.completion') {
        return Promise.resolve(args.body);
    }
    return (args.resolveBridge ?? importResponsesHandlerCoreDist)('conversion/responses/responses-openai-bridge').then((mod) => {
        if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
            throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
        }
        return mod.buildResponsesPayloadFromChat(args.body, {
            requestId: args.requestLabel
        });
    });
}
export function requireResponsesHandlerCoreDist(specifier) {
    return requireCoreDist(specifier);
}
export async function importResponsesHandlerCoreDist(specifier) {
    return await importCoreDist(specifier);
}
export async function buildResponsesPayloadFromChatForHttp(payload, context) {
    return buildResponsesPayloadFromChatNative(payload, context);
}
function readResponsesRequestModelForHttp(requestContext) {
    const payloadModel = requestContext?.payload?.model;
    if (typeof payloadModel === 'string' && payloadModel.trim()) {
        return payloadModel.trim();
    }
    const contextModel = requestContext?.context?.model;
    if (typeof contextModel === 'string' && contextModel.trim()) {
        return contextModel.trim();
    }
    return undefined;
}
function ensureResponsesJsonToSseRequiredFieldsForHttp(args) {
    if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
        return args.payload;
    }
    const payload = args.payload;
    if (payload.object !== 'response') {
        return args.payload;
    }
    if (typeof payload.model === 'string' && payload.model.trim()) {
        return args.payload;
    }
    const model = readResponsesRequestModelForHttp(args.requestContext);
    if (!model) {
        return args.payload;
    }
    return {
        ...payload,
        model,
    };
}
function readResponsesClientToolsRawForHttp(requestContext) {
    const contextToolsRaw = requestContext?.context?.toolsRaw;
    if (Array.isArray(contextToolsRaw)) {
        return contextToolsRaw;
    }
    const contextClientToolsRaw = requestContext?.context?.clientToolsRaw;
    if (Array.isArray(contextClientToolsRaw)) {
        return contextClientToolsRaw;
    }
    const payloadTools = requestContext?.payload?.tools;
    if (Array.isArray(payloadTools)) {
        return payloadTools;
    }
    return [];
}
export async function normalizeResponsesClientPayloadForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses'
        && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
        return args.payload;
    }
    if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
        return args.payload;
    }
    const projectedPayload = projectResponsesClientPayloadForClientNative({
        payload: args.payload,
        toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
        metadata: args.metadata,
    });
    return ensureResponsesJsonToSseRequiredFieldsForHttp({
        payload: stripClientVisibleMetadataDeep(projectedPayload),
        requestContext: args.requestContext,
    });
}
export async function prepareResponsesJsonSseDispatchPlanForHttp(args) {
    const normalizedPayload = ensureResponsesJsonToSseRequiredFieldsForHttp({
        payload: args.responsesPayload,
        requestContext: args.requestContext,
    });
    const sanitizedPayload = stripInternalKeysDeep(normalizedPayload);
    return {
        normalizedPayload,
        sanitizedPayload,
    };
}
export async function prepareResponsesJsonClientDispatchPlanForHttp(args) {
    const normalizedJsonBody = await normalizeResponsesJsonBodyForHttp({
        body: args.body,
        entryEndpoint: args.entryEndpoint,
        requestLabel: args.requestLabel,
        resolveBridge: args.resolveBridge,
    });
    const clientBody = await normalizeResponsesClientPayloadForHttp({
        payload: normalizedJsonBody,
        entryEndpoint: args.entryEndpoint,
        requestContext: args.requestContext,
        metadata: args.metadata,
    });
    return {
        clientBody,
        sanitizedBody: stripInternalKeysDeep(clientBody),
    };
}
function stripClientVisibleMetadataDeep(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripClientVisibleMetadataDeep(item));
    }
    const record = value;
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
        if (key === 'metadata') {
            continue;
        }
        out[key] = stripClientVisibleMetadataDeep(entry);
    }
    return out;
}
//# sourceMappingURL=responses-response-bridge.js.map