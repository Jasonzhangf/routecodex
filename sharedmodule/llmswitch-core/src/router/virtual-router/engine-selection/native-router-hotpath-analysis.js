export function parsePendingToolSyncPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ready !== 'boolean') {
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
    catch {
        return null;
    }
}
export function parseContinueExecutionInjectionPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.hasDirective !== 'boolean') {
            return null;
        }
        return { hasDirective: parsed.hasDirective };
    }
    catch {
        return null;
    }
}
export function parseChatProcessMediaAnalysisPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.containsCurrentTurnImage !== 'boolean') {
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
    catch {
        return null;
    }
}
export function parseChatProcessMediaStripPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.changed !== 'boolean' || !Array.isArray(parsed.messages)) {
            return null;
        }
        return {
            changed: parsed.changed,
            messages: parsed.messages
        };
    }
    catch {
        return null;
    }
}
export function parseChatWebSearchIntentPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.hasIntent !== 'boolean' || typeof parsed.googlePreferred !== 'boolean') {
            return null;
        }
        return {
            hasIntent: parsed.hasIntent,
            googlePreferred: parsed.googlePreferred
        };
    }
    catch {
        return null;
    }
}
export function parseClockClearDirectivePayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.hadClear !== 'boolean' || typeof parsed.next !== 'string') {
            return null;
        }
        return {
            hadClear: parsed.hadClear,
            next: parsed.next
        };
    }
    catch {
        return null;
    }
}
export function parseProviderKeyPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
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
    catch {
        return null;
    }
}
export function parseAntigravitySessionIdPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'string') {
            return null;
        }
        const sessionId = parsed.trim();
        if (!sessionId) {
            return null;
        }
        return { sessionId };
    }
    catch {
        return null;
    }
}
export function parseAntigravityPinnedAliasLookupPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
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
    catch {
        return null;
    }
}
export function parseAntigravityPinnedAliasUnpinPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.changed !== 'boolean') {
            return null;
        }
        return { changed: parsed.changed };
    }
    catch {
        return null;
    }
}
export function parseAntigravityCacheSignaturePayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ok !== 'boolean') {
            return null;
        }
        return { ok: parsed.ok };
    }
    catch {
        return null;
    }
}
export function parseAntigravityRequestSessionMetaPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
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
    catch {
        return null;
    }
}
//# sourceMappingURL=native-router-hotpath-analysis.js.map