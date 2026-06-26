/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE projection-facing facade for responses SSE/JSON streaming
 * behaviors. Lifecycle persistence stays in responses-response-bridge.ts.
 */
import { buildResponsesMissingSseBridgeErrorPayloadForHttp as buildResponsesMissingSseBridgeErrorPayloadForHttpImpl, buildResponsesPayloadFromChatForHttp as buildResponsesPayloadFromChatForHttpImpl, buildResponsesRequestLogContextForHttp as buildResponsesRequestLogContextForHttpImpl, buildResponsesSseErrorPayloadForHttp as buildResponsesSseErrorPayloadForHttpImpl, buildResponsesStructuredSseErrorPayloadForHttp as buildResponsesStructuredSseErrorPayloadForHttpImpl, createChatJsonToSseConverterForHttp as createChatJsonToSseConverterForHttpImpl, importResponsesHandlerCoreDist as importResponsesHandlerCoreDistImpl, normalizeChatUsagePayloadForHttp as normalizeChatUsagePayloadForHttpImpl, prepareResponsesJsonBodyForSseBridgeForHttp as prepareResponsesJsonBodyForSseBridgeForHttpImpl, prepareResponsesJsonClientDispatchPlanForHttp as prepareResponsesJsonClientDispatchPlanForHttpImpl, prepareResponsesJsonSseDispatchPlanForHttp as prepareResponsesJsonSseDispatchPlanForHttpImpl, requireResponsesHandlerCoreDist as requireResponsesHandlerCoreDistImpl, resolveResponsesClientPayloadFinishReasonForHttp as resolveResponsesClientPayloadFinishReasonForHttpImpl, resolveResponsesRequestContextForHttp as resolveResponsesRequestContextForHttpImpl, resolveRelayResponsesClientSseStreamForHttp as resolveRelayResponsesClientSseStreamForHttpImpl, shouldDispatchResponsesSseToClientForHttp as shouldDispatchResponsesSseToClientForHttpImpl, shouldReprojectRelayResponsesSseForHttp as shouldReprojectRelayResponsesSseForHttpImpl, } from './responses-response-bridge.js';
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl, createResponsesJsonToSseConverterForHttp as createResponsesJsonToSseConverterForHttpImpl, normalizeResponsesSseFrameForClientForHttp as normalizeResponsesSseFrameForClientForHttpImpl, projectResponsesSseFrameForClientForHttp as projectResponsesSseFrameForClientForHttpImpl, resolveResponsesProviderProtocolHintFromSseFrameForHttp as resolveResponsesProviderProtocolHintFromSseFrameForHttpImpl, shouldDropClientSseFrameForHttp as shouldDropClientSseFrameForHttpImpl, summarizeResponsesSseFrameForLogForHttp as summarizeResponsesSseFrameForLogForHttpImpl, } from './responses-sse-semantics.js';
export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
export const buildResponsesMissingSseBridgeErrorPayloadForHttp = buildResponsesMissingSseBridgeErrorPayloadForHttpImpl;
export const buildResponsesPayloadFromChatForHttp = buildResponsesPayloadFromChatForHttpImpl;
export const buildResponsesRequestLogContextForHttp = buildResponsesRequestLogContextForHttpImpl;
export const buildResponsesSseErrorPayloadForHttp = buildResponsesSseErrorPayloadForHttpImpl;
export const buildResponsesStructuredSseErrorPayloadForHttp = buildResponsesStructuredSseErrorPayloadForHttpImpl;
export const createChatJsonToSseConverterForHttp = createChatJsonToSseConverterForHttpImpl;
export const createResponsesJsonToSseConverterForHttp = createResponsesJsonToSseConverterForHttpImpl;
export const importResponsesHandlerCoreDist = importResponsesHandlerCoreDistImpl;
export const normalizeChatUsagePayloadForHttp = normalizeChatUsagePayloadForHttpImpl;
export const normalizeResponsesSseFrameForClientForHttp = normalizeResponsesSseFrameForClientForHttpImpl;
export const prepareResponsesJsonBodyForSseBridgeForHttp = prepareResponsesJsonBodyForSseBridgeForHttpImpl;
export const prepareResponsesJsonClientDispatchPlanForHttp = prepareResponsesJsonClientDispatchPlanForHttpImpl;
export const prepareResponsesJsonSseDispatchPlanForHttp = prepareResponsesJsonSseDispatchPlanForHttpImpl;
export const projectResponsesSseFrameForClientForHttp = projectResponsesSseFrameForClientForHttpImpl;
export const requireResponsesHandlerCoreDist = requireResponsesHandlerCoreDistImpl;
export const resolveResponsesClientPayloadFinishReasonForHttp = resolveResponsesClientPayloadFinishReasonForHttpImpl;
export const resolveResponsesProviderProtocolHintFromSseFrameForHttp = resolveResponsesProviderProtocolHintFromSseFrameForHttpImpl;
export const resolveResponsesRequestContextForHttp = resolveResponsesRequestContextForHttpImpl;
export const resolveRelayResponsesClientSseStreamForHttp = resolveRelayResponsesClientSseStreamForHttpImpl;
export const shouldDispatchResponsesSseToClientForHttp = shouldDispatchResponsesSseToClientForHttpImpl;
export const shouldDropClientSseFrameForHttp = shouldDropClientSseFrameForHttpImpl;
export const shouldReprojectRelayResponsesSseForHttp = shouldReprojectRelayResponsesSseForHttpImpl;
export const summarizeResponsesSseFrameForLogForHttp = summarizeResponsesSseFrameForLogForHttpImpl;
export async function reprojectDirectChatToolCallStreamForHttp(args) {
    const converter = await createChatJsonToSseConverterForHttpImpl();
    return await converter.convertResponseToJsonToSse(args.body, {
        requestId: args.requestId,
    });
}
const RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS = new Set([
    'error',
    'ping',
    'response.queued',
    'response.created',
    'response.in_progress',
    'response.incomplete',
    'response.completed',
    'response.failed',
    'response.cancelled',
    'response.done',
    'response.metadata',
    'response.output_item.added',
    'response.output_item.done',
    'response.content_part.added',
    'response.content_part.done',
    'response.output_text.annotation.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.audio.delta',
    'response.audio.done',
    'response.audio.transcript.delta',
    'response.audio.transcript.done',
    'response.refusal.delta',
    'response.refusal.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
    'response.code_interpreter_call.in_progress',
    'response.code_interpreter_call.interpreting',
    'response.code_interpreter_call.completed',
    'response.code_interpreter_call_code.delta',
    'response.code_interpreter_call_code.done',
    'response.file_search_call.in_progress',
    'response.file_search_call.searching',
    'response.file_search_call.completed',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_text.delta',
    'response.reasoning_text.done',
    'response.reasoning.delta',
    'response.reasoning.done',
    'response.web_search_call.in_progress',
    'response.web_search_call.searching',
    'response.web_search_call.completed',
    'response.image_generation_call.in_progress',
    'response.image_generation_call.generating',
    'response.image_generation_call.partial_image',
    'response.image_generation_call.completed',
    'response.mcp_call.in_progress',
    'response.mcp_call_arguments.delta',
    'response.mcp_call_arguments.done',
    'response.mcp_call.completed',
    'response.mcp_call.failed',
    'response.mcp_list_tools.in_progress',
    'response.mcp_list_tools.completed',
    'response.mcp_list_tools.failed',
]);
function isResponsesRequiredActionFrame(frame) {
    return frame.split(/\r?\n/).some((line) => {
        if (!line.startsWith('data:')) {
            return false;
        }
        const data = line.slice('data:'.length).trim();
        if (!data || data === '[DONE]') {
            return false;
        }
        try {
            const parsed = JSON.parse(data);
            return parsed.type === 'response.required_action';
        }
        catch {
            return false;
        }
    });
}
function isInternalMetadataCarrierForHttp(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return Object.keys(value).some((key) => key.startsWith('__routecodex') || key.startsWith('__rt') || key === 'providerKey');
}
export function isDirectPassthroughTransportKeepaliveFrameForHttp(frame) {
    const trimmed = frame.trim();
    if (!trimmed) {
        return false;
    }
    const lines = trimmed.split(/\r?\n/);
    const eventNames = lines
        .filter((line) => line.startsWith('event:'))
        .map((line) => line.slice('event:'.length).trim())
        .filter(Boolean);
    if (eventNames.length !== 1 || eventNames[0] !== 'keepalive') {
        return false;
    }
    return lines.every((line) => !line || line.startsWith('event:') || line.startsWith('data:') || line.startsWith(':'));
}
export function assertDirectPassthroughResponsesSseFrameForHttp(frame, requestId) {
    const eventNames = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('event:'))
        .map((line) => line.slice('event:'.length).trim())
        .filter(Boolean);
    for (const eventName of eventNames) {
        if (!RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS.has(eventName)) {
            throw Object.assign(new Error(`[server.response_projection] direct passthrough SSE emitted non-Responses event "${eventName}" (requestId=${requestId})`), { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' });
        }
    }
    if (isDirectPassthroughTransportKeepaliveFrameForHttp(frame)) {
        return;
    }
    if (isResponsesRequiredActionFrame(frame)) {
        throw Object.assign(new Error(`[server.response_projection] direct passthrough SSE must not rewrite response.required_action into output_item/function_call frames (requestId=${requestId})`), { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' });
    }
}
export function assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, requestId) {
    assertDirectPassthroughResponsesSseFrameForHttp(frame, requestId);
    for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const dataText = line.slice(5).trim();
        if (!dataText || dataText === '[DONE]') {
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(dataText);
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }
        const stack = [parsed];
        const seen = new WeakSet();
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || seen.has(current)) {
                continue;
            }
            seen.add(current);
            const metadata = current.metadata;
            if (metadata !== undefined) {
                if (isInternalMetadataCarrierForHttp(metadata)) {
                    throw new Error(`[server.response_projection] direct passthrough SSE metadata contains internal control fields (requestId=${requestId})`);
                }
                if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
                    stack.push(metadata);
                }
            }
            for (const [key, value] of Object.entries(current)) {
                if (key === 'metadata') {
                    continue;
                }
                if (key === 'metaCarrier'
                    || key === 'runtimeMetadata'
                    || key === 'errorCarrier'
                    || key === '__rt') {
                    throw new Error(`[server.response_projection] client response contains internal carrier field "${key}" (requestId=${requestId})`);
                }
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    stack.push(value);
                }
            }
        }
    }
}
export function sanitizeDirectPassthroughResponsesSseFrameForHttp(frame, _requestId) {
    return frame;
}
