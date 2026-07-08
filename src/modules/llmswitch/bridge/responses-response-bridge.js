import { buildResponsesPayloadFromChatNative, planResponsesJsonClientDispatchNative, projectResponsesClientPayloadForClientNative, } from './native-exports.js';
import { readRuntimeRequestTruthIdentifiers, } from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';
import { stripInternalKeysDeep } from '../../../utils/strip-internal-keys.js';
function asRecordForHttp(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function readTrimmedStringForHttp(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
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
    const sessionId = readTrimmedStringForHttp(usageLogInfo.sessionId)
        ?? readTrimmedStringForHttp(usageLogInfo.session_id)
        ?? readTrimmedStringForHttp(metadata.sessionId)
        ?? readTrimmedStringForHttp(metadata.session_id)
        ?? requestTruth.sessionId;
    const conversationId = readTrimmedStringForHttp(usageLogInfo.conversationId)
        ?? readTrimmedStringForHttp(usageLogInfo.conversation_id)
        ?? readTrimmedStringForHttp(metadata.conversationId)
        ?? readTrimmedStringForHttp(metadata.conversation_id)
        ?? requestTruth.conversationId;
    return {
        logSessionColorKey: usageLogInfo.logSessionColorKey ?? metadata.logSessionColorKey,
        clientTmuxSessionId: usageLogInfo.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
        client_tmux_session_id: usageLogInfo.client_tmux_session_id ?? metadata.client_tmux_session_id,
        tmuxSessionId: usageLogInfo.tmuxSessionId ?? metadata.tmuxSessionId,
        tmux_session_id: usageLogInfo.tmux_session_id ?? metadata.tmux_session_id,
        rccSessionClientTmuxSessionId: usageLogInfo.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
        rcc_session_client_tmux_session_id: usageLogInfo.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
        sessionId,
        session_id: sessionId,
        conversationId,
        conversation_id: conversationId
    };
}
export async function rebindResponsesConversationRequestIdForHttp(oldId, newId) {
    const { rebindResponsesConversationRequestId } = await import('./runtime-integrations.js');
    await rebindResponsesConversationRequestId(oldId, newId);
}
export async function normalizeResponsesJsonBodyForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses') {
        return args.body;
    }
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
        return args.body;
    }
    if (args.body.object !== 'chat.completion') {
        return args.body;
    }
    return buildResponsesPayloadFromChatNative(args.body, {
        requestId: args.requestLabel,
    });
}
export async function normalizeResponsesClientPayloadForHttp(args) {
    if (args.entryEndpoint !== '/v1/responses'
        && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
        return args.payload;
    }
    if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
        return args.payload;
    }
    const toolsRaw = args.requestContext?.context?.toolsRaw;
    if (!Array.isArray(toolsRaw)) {
        throw new Error('Responses client projection requires requestContext.context.toolsRaw');
    }
    return projectResponsesClientPayloadForClientNative({
        payload: args.payload,
        toolsRaw,
        metadata: args.metadata,
        context: args.requestContext
            ? {
                originalRequest: args.requestContext.payload,
                requestContext: args.requestContext.context,
            }
            : undefined,
    });
}
export async function prepareResponsesJsonClientDispatchPlanForHttp(args) {
    const dispatchPlan = planResponsesJsonClientDispatchNative({
        entryEndpoint: args.entryEndpoint,
        continuationOwner: args.continuationOwner,
        hasRequestContextToolsRaw: Array.isArray(args.requestContext?.context?.toolsRaw),
    });
    if (dispatchPlan.action === 'direct_passthrough') {
        return {
            clientBody: args.body,
            sanitizedBody: args.body,
        };
    }
    if (dispatchPlan.action !== 'project_client_payload') {
        throw new Error(`[responses] unsupported JSON client dispatch action: ${String(dispatchPlan.action ?? 'unknown')}`);
    }
    const normalizedJsonBody = await normalizeResponsesJsonBodyForHttp({
        body: args.body,
        entryEndpoint: args.entryEndpoint,
        requestLabel: args.requestLabel,
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
//# sourceMappingURL=responses-response-bridge.js.map
