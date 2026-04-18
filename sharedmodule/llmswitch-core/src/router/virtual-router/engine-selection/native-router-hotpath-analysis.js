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
export function parseAntigravitySessionIdPayload(raw) {
    const parsed = parseJson('parseAntigravitySessionIdPayload', raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string') {
        return null;
    }
    const sessionId = parsed.trim();
    if (!sessionId) {
        return null;
    }
    return { sessionId };
}
export function parseAntigravityPinnedAliasLookupPayload(raw) {
    const parsed = parseJson('parseAntigravityPinnedAliasLookupPayload', raw);
    if (parsed === JSON_PARSE_FAILED) {
        return null;
    }
    if (parsed === null) {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    if (parsed.alias === undefined || parsed.alias === null) {
        return {};
    }
    if (typeof parsed.alias !== 'string') {
        return null;
    }
    const alias = parsed.alias.trim();
    if (!alias) {
        return {};
    }
    return { alias };
}
export function parseAntigravityPinnedAliasUnpinPayload(raw) {
    const parsed = parseJson('parseAntigravityPinnedAliasUnpinPayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean') {
        return null;
    }
    return { changed: parsed.changed };
}
export function parseAntigravityCacheSignaturePayload(raw) {
    const parsed = parseJson('parseAntigravityCacheSignaturePayload', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.ok !== 'boolean') {
        return null;
    }
    return { ok: parsed.ok };
}
export function parseAntigravityRequestSessionMetaPayload(raw) {
    const parsed = parseJson('parseAntigravityRequestSessionMetaPayload', raw);
    if (parsed === JSON_PARSE_FAILED) {
        return null;
    }
    if (parsed === null) {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const aliasKey = typeof parsed.aliasKey === 'string' && parsed.aliasKey.trim().length
        ? parsed.aliasKey.trim()
        : undefined;
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length
        ? parsed.sessionId.trim()
        : undefined;
    const messageCount = typeof parsed.messageCount === 'number' && Number.isFinite(parsed.messageCount) && parsed.messageCount > 0
        ? Math.floor(parsed.messageCount)
        : undefined;
    return {
        ...(aliasKey ? { aliasKey } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(messageCount !== undefined ? { messageCount } : {})
    };
}
//# sourceMappingURL=native-router-hotpath-analysis.js.map
