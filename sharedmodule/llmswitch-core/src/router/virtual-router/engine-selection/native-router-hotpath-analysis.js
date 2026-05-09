const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60000;
const nonBlockingParseLogState = new Map();
const JSON_PARSE_FAILED = Symbol('native-router-hotpath-analysis.parse-failed');
function formatUnknownError(error) {
    if (error instanceof Error) {
        return error.stack || `${error.name}: ${error.message}`;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error ?? 'unknown');
    }
}
function logNativeRouterHotpathAnalysisNonBlocking(stage, error) {
    const now = Date.now();
    const last = nonBlockingParseLogState.get(stage) ?? 0;
    if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
        return;
    }
    nonBlockingParseLogState.set(stage, now);
    console.warn(`[native-router-hotpath-analysis] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`);
}
function parseJson(stage, raw) {
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        logNativeRouterHotpathAnalysisNonBlocking(stage, error);
        return JSON_PARSE_FAILED;
    }
}
export function parsePendingToolSyncPayload(raw) {
    const parsed = parseJson('parsePendingToolSyncPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.ready !== 'boolean') {
        return null;
    }
    const insertAt = typeof parsed.insertAt === 'number' && Number.isFinite(parsed.insertAt)
        ? Math.floor(parsed.insertAt)
        : -1;
    return {
        ready: parsed.ready,
        insertAt
    };
}
export function parseContinueExecutionInjectionPayload(raw) {
    const parsed = parseJson('parseContinueExecutionInjectionPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hasDirective !== 'boolean') {
        return null;
    }
    return { hasDirective: parsed.hasDirective };
}
export function parseChatProcessMediaAnalysisPayload(raw) {
    const parsed = parseJson('parseChatProcessMediaAnalysisPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.containsCurrentTurnImage !== 'boolean') {
        return null;
    }
    const stripIndices = Array.isArray(parsed.stripIndices)
        ? parsed.stripIndices
            .filter((value) => typeof value === 'number' && Number.isFinite(value))
            .map((value) => Math.floor(value))
        : [];
    return {
        stripIndices,
        containsCurrentTurnImage: parsed.containsCurrentTurnImage
    };
}
export function parseChatProcessMediaStripPayload(raw) {
    const parsed = parseJson('parseChatProcessMediaStripPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean' || !Array.isArray(parsed.messages)) {
        return null;
    }
    return {
        changed: parsed.changed,
        messages: parsed.messages
    };
}
export function parseChatWebSearchIntentPayload(raw) {
    const parsed = parseJson('parseChatWebSearchIntentPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hasIntent !== 'boolean' || typeof parsed.googlePreferred !== 'boolean') {
        return null;
    }
    return {
        hasIntent: parsed.hasIntent,
        googlePreferred: parsed.googlePreferred
    };
}
export function parseClockClearDirectivePayload(raw) {
    const parsed = parseJson('parseClockClearDirectivePayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hadClear !== 'boolean' || typeof parsed.next !== 'string') {
        return null;
    }
    return {
        hadClear: parsed.hadClear,
        next: parsed.next
    };
}
export function parseProviderKeyPayload(raw) {
    const parsed = parseJson('parseProviderKeyPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object') {
        return null;
    }
    const providerId = typeof parsed.providerId === 'string'
        ? parsed.providerId
        : parsed.providerId === null
            ? null
            : null;
    const alias = typeof parsed.alias === 'string'
        ? parsed.alias
        : parsed.alias === null
            ? null
            : null;
    const keyIndex = typeof parsed.keyIndex === 'number' && Number.isFinite(parsed.keyIndex)
        ? Math.floor(parsed.keyIndex)
        : undefined;
    return {
        providerId,
        alias,
        ...(keyIndex !== undefined ? { keyIndex } : {})
    };
}
export function parseServertoolResponseStagePayload(raw) {
    const parsed = parseJson('parseServertoolResponseStagePayload', raw);
    if (parsed === JSON_PARSE_FAILED ||
        !parsed ||
        typeof parsed.providerResponseShape !== 'string' ||
        typeof parsed.isCanonicalChatCompletionPayload !== 'boolean' ||
        !Array.isArray(parsed.toolCalls)) {
        return null;
    }
    const toolCalls = parsed.toolCalls
        .filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
        .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        arguments: typeof entry.arguments === 'string' ? entry.arguments : ''
    }))
        .filter((entry) => entry.id && entry.name);
    const payloadContractSignal = parsed.payloadContractSignal &&
        typeof parsed.payloadContractSignal === 'object' &&
        !Array.isArray(parsed.payloadContractSignal) &&
        typeof parsed.payloadContractSignal.reason === 'string' &&
        typeof parsed.payloadContractSignal.marker === 'string'
        ? {
            reason: String(parsed.payloadContractSignal.reason),
            marker: String(parsed.payloadContractSignal.marker)
        }
        : parsed.payloadContractSignal == null
            ? null
            : undefined;
    return {
        providerResponseShape: parsed.providerResponseShape,
        isCanonicalChatCompletionPayload: parsed.isCanonicalChatCompletionPayload,
        ...(payloadContractSignal !== undefined ? { payloadContractSignal } : {}),
        normalizedPayload: parsed.normalizedPayload,
        toolCalls
    };
}
export function parseServertoolDispatchPlanPayload(raw) {
    const parsed = parseJson('parseServertoolDispatchPlanPayload', raw);
    if (parsed === JSON_PARSE_FAILED ||
        !parsed ||
        !Array.isArray(parsed.executableToolCalls) ||
        !Array.isArray(parsed.skippedToolCalls)) {
        return null;
    }
    const executableToolCalls = parsed.executableToolCalls
        .filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
        .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
        executionMode: typeof entry.executionMode === 'string' ? entry.executionMode : '',
        stripAfterExecute: entry.stripAfterExecute === true
    }))
        .filter((entry) => entry.id && entry.name && entry.executionMode);
    const skippedToolCalls = parsed.skippedToolCalls
        .filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
        .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        reason: typeof entry.reason === 'string' ? entry.reason : ''
    }))
        .filter((entry) => entry.id && entry.name && entry.reason);
    return {
        executableToolCalls,
        skippedToolCalls
    };
}
export function parseServertoolOutcomePlanPayload(raw) {
    const parsed = parseJson('parseServertoolOutcomePlanPayload', raw);
    if (parsed === JSON_PARSE_FAILED ||
        !parsed ||
        typeof parsed.outcomeMode !== 'string' ||
        !Array.isArray(parsed.remainingToolCallIds) ||
        !Array.isArray(parsed.aliasSessionIds) ||
        !Array.isArray(parsed.pendingInjectionMessageKinds) ||
        !Array.isArray(parsed.pendingInjectionMessagesResolved) ||
        typeof parsed.useLastExecutionFollowup !== 'boolean' ||
        typeof parsed.useGenericFollowup !== 'boolean' ||
        typeof parsed.followupStrategy !== 'string' ||
        typeof parsed.requiresPendingInjection !== 'boolean' ||
        !Array.isArray(parsed.followupInjectionOps) ||
        !Array.isArray(parsed.followupInjectionOpsResolved)) {
        return null;
    }
    return {
        outcomeMode: parsed.outcomeMode,
        remainingToolCallIds: parsed.remainingToolCallIds
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim()),
        ...(typeof parsed.pendingSessionId === 'string' && parsed.pendingSessionId.trim()
            ? { pendingSessionId: parsed.pendingSessionId.trim() }
            : parsed.pendingSessionId === null
                ? { pendingSessionId: null }
                : {}),
        aliasSessionIds: parsed.aliasSessionIds
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim()),
        pendingInjectionMessageKinds: parsed.pendingInjectionMessageKinds
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim()),
        pendingInjectionMessagesResolved: parsed.pendingInjectionMessagesResolved,
        ...(typeof parsed.flowId === 'string' && parsed.flowId.trim()
            ? { flowId: parsed.flowId.trim() }
            : parsed.flowId === null
                ? { flowId: null }
                : {}),
        useLastExecutionFollowup: parsed.useLastExecutionFollowup,
        useGenericFollowup: parsed.useGenericFollowup,
        followupStrategy: parsed.followupStrategy,
        requiresPendingInjection: parsed.requiresPendingInjection,
        followupInjectionOps: parsed.followupInjectionOps
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim()),
        followupInjectionOpsResolved: parsed.followupInjectionOpsResolved,
        ...(typeof parsed.primaryExecutionMode === 'string' && parsed.primaryExecutionMode.trim()
            ? { primaryExecutionMode: parsed.primaryExecutionMode.trim() }
            : parsed.primaryExecutionMode === null
                ? { primaryExecutionMode: null }
                : {})
    };
}
export function parseServertoolAutoHookQueuesPayload(raw) {
    const parsed = parseJson('parseServertoolAutoHookQueuesPayload', raw);
    if (parsed === JSON_PARSE_FAILED ||
        !parsed ||
        !Array.isArray(parsed.optionalQueue) ||
        !Array.isArray(parsed.mandatoryQueue)) {
        return null;
    }
    const normalizeQueue = (entries) => entries
        .filter((entry) => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
        .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        phase: typeof entry.phase === 'string' ? entry.phase : 'default',
        priority: typeof entry.priority === 'number' && Number.isFinite(entry.priority)
            ? Math.floor(entry.priority)
            : 100,
        order: typeof entry.order === 'number' && Number.isFinite(entry.order)
            ? Math.floor(entry.order)
            : 0
    }))
        .filter((entry) => entry.id.length > 0);
    return {
        optionalQueue: normalizeQueue(parsed.optionalQueue),
        mandatoryQueue: normalizeQueue(parsed.mandatoryQueue)
    };
}
export function parseServertoolGenericFollowupPayload(raw) {
    const parsed = parseJson('parseServertoolGenericFollowupPayload', raw);
    if (parsed === JSON_PARSE_FAILED ||
        !parsed ||
        typeof parsed.model !== 'string' ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.tools)) {
        return null;
    }
    return {
        model: parsed.model.trim(),
        messages: parsed.messages,
        tools: parsed.tools,
        ...(parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
            ? { parameters: parsed.parameters }
            : {})
    };
}
export function parseServertoolFollowupFlowProfilePayload(raw) {
    const parsed = parseJson('parseServertoolFollowupFlowProfilePayload', raw);
    if (parsed === JSON_PARSE_FAILED) {
        return null;
    }
    if (parsed === null) {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const profile = parsed;
    return {
        ...(profile.noFollowup === true ? { noFollowup: true } : {}),
        ...(profile.autoLimit === true ? { autoLimit: true } : {}),
        ...(profile.flowOnlyLoopLimit === true ? { flowOnlyLoopLimit: true } : {}),
        ...(profile.stickyProvider === true ? { stickyProvider: true } : {}),
        ...(profile.clientInjectOnly === true ? { clientInjectOnly: true } : {}),
        ...(profile.seedLoopPayload === true ? { seedLoopPayload: true } : {}),
        ...(profile.retryEmptyFollowupOnce === true ? { retryEmptyFollowupOnce: true } : {}),
        ...(typeof profile.clientInjectSource === 'string' && profile.clientInjectSource.trim()
            ? { clientInjectSource: profile.clientInjectSource.trim() }
            : {}),
        ...(typeof profile.transparentReplayRequestSuffix === 'string' && profile.transparentReplayRequestSuffix.trim()
            ? { transparentReplayRequestSuffix: profile.transparentReplayRequestSuffix.trim() }
            : {}),
        ...(profile.ignoreRequiresActionFollowup === true ? { ignoreRequiresActionFollowup: true } : {}),
        ...(profile.contextDecorationMode === 'continue_execution_summary' || profile.contextDecorationMode === 'web_search_summary'
            ? { contextDecorationMode: profile.contextDecorationMode }
            : {})
    };
}
export function parseServertoolFollowupRuntimePlanPayload(raw) {
    const parsed = parseJson('parseServertoolFollowupRuntimePlanPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const plan = parsed;
    if (plan.outcomeMode !== 'skip' &&
        plan.outcomeMode !== 'client_inject_only' &&
        plan.outcomeMode !== 'reenter') {
        return null;
    }
    return {
        outcomeMode: plan.outcomeMode,
        noFollowup: plan.noFollowup === true,
        autoLimit: plan.autoLimit === true,
        flowOnlyLoopLimit: plan.flowOnlyLoopLimit === true,
        stickyProvider: plan.stickyProvider === true,
        clientInjectOnly: plan.clientInjectOnly === true,
        seedLoopPayload: plan.seedLoopPayload === true,
        retryEmptyFollowupOnce: plan.retryEmptyFollowupOnce === true,
        ignoreRequiresActionFollowup: plan.ignoreRequiresActionFollowup === true,
        ...(typeof plan.clientInjectSource === 'string' && plan.clientInjectSource.trim()
            ? { clientInjectSource: plan.clientInjectSource.trim() }
            : {}),
        ...(typeof plan.transparentReplayRequestSuffix === 'string' && plan.transparentReplayRequestSuffix.trim()
            ? { transparentReplayRequestSuffix: plan.transparentReplayRequestSuffix.trim() }
            : {}),
        ...(plan.contextDecorationMode === 'continue_execution_summary' || plan.contextDecorationMode === 'web_search_summary'
            ? { contextDecorationMode: plan.contextDecorationMode }
            : {})
    };
}
//# sourceMappingURL=native-router-hotpath-analysis.js.map
