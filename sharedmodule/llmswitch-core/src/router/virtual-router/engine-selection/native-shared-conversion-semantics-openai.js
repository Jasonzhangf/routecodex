import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function normalizeContentPartWithNative(part, reasoningCollector) {
    const capability = 'normalizeOutputContentPartJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const partJson = safeStringify(part ?? null);
    const collectorJson = safeStringify(Array.isArray(reasoningCollector) ? reasoningCollector : []);
    if (!partJson || !collectorJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(partJson, collectorJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const normalized = parsed.normalized === null
            ? null
            : parsed.normalized && typeof parsed.normalized === 'object' && !Array.isArray(parsed.normalized)
                ? parsed.normalized
                : fail('invalid payload');
        const nextCollector = Array.isArray(parsed.reasoningCollector)
            ? parsed.reasoningCollector.filter((entry) => typeof entry === 'string')
            : [];
        return { normalized, reasoningCollector: nextCollector };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeMessageContentPartsWithNative(parts, reasoningCollector) {
    const capability = 'normalizeMessageContentPartsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const partsJson = safeStringify(parts ?? null);
    const collectorJson = safeStringify(Array.isArray(reasoningCollector) ? reasoningCollector : []);
    if (!partsJson || !collectorJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(partsJson, collectorJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const normalizedParts = Array.isArray(parsed.normalizedParts)
            ? parsed.normalizedParts.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            : [];
        const reasoningChunks = Array.isArray(parsed.reasoningChunks)
            ? parsed.reasoningChunks.filter((entry) => typeof entry === 'string')
            : [];
        return { normalizedParts, reasoningChunks };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeChatMessageContentWithNative(content) {
    const capability = 'normalizeChatMessageContentJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(content ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const contentText = typeof parsed.contentText === 'string' ? parsed.contentText : undefined;
        const reasoningText = typeof parsed.reasoningText === 'string' ? parsed.reasoningText : undefined;
        return {
            ...(contentText ? { contentText } : {}),
            ...(reasoningText ? { reasoningText } : {})
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeOpenaiMessageWithNative(message, disableShellCoerce) {
    const capability = 'normalizeOpenaiMessageJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(message ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson, Boolean(disableShellCoerce));
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return fail('invalid payload');
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeOpenaiToolWithNative(tool) {
    const capability = 'normalizeOpenaiToolJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(tool ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return fail('invalid payload');
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-openai.js.map