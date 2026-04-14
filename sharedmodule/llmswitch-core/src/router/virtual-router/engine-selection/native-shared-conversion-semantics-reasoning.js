import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
function parseExtractToolCallsOutput(raw) {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const row = parsed;
    if (typeof row.cleanedText !== 'string' || !Array.isArray(row.toolCalls)) {
        return null;
    }
    const toolCalls = row.toolCalls.filter((entry) => entry && typeof entry === 'object');
    return {
        cleanedText: row.cleanedText,
        toolCalls
    };
}
function parseExtractReasoningSegmentsOutput(raw) {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const row = parsed;
    if (typeof row.text !== 'string' || !Array.isArray(row.segments)) {
        return null;
    }
    const segments = row.segments.filter((entry) => typeof entry === 'string');
    if (segments.length !== row.segments.length) {
        return null;
    }
    return { text: row.text, segments };
}
function parseNormalizeReasoningOutput(raw) {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const row = parsed;
    return { payload: row.payload };
}
function normalizeToolCallEntries(raw) {
    return raw
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => {
        const row = entry;
        const functionRow = row.function && typeof row.function === 'object' && !Array.isArray(row.function)
            ? row.function
            : null;
        const name = (typeof functionRow?.name === 'string'
            ? functionRow.name
            : typeof row.name === 'string'
                ? row.name
                : '').trim();
        const argsCandidate = typeof functionRow?.arguments === 'string'
            ? functionRow.arguments
            : typeof row.args === 'string'
                ? row.args
                : typeof row.arguments === 'string'
                    ? row.arguments
                    : '';
        if (!name) {
            return null;
        }
        return {
            ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
            type: 'function',
            function: {
                name,
                arguments: argsCandidate
            }
        };
    })
        .filter((entry) => Boolean(entry));
}
export function extractToolCallsFromReasoningTextWithNative(text, idPrefix) {
    const capability = 'extractToolCallsFromReasoningTextJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    try {
        const raw = fn(String(text ?? ''), idPrefix);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseExtractToolCallsOutput(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function extractReasoningSegmentsWithNative(text) {
    const capability = 'extractReasoningSegmentsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    try {
        const raw = fn(String(text ?? ''));
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseExtractReasoningSegmentsOutput(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeAssistantTextToToolCallsWithNative(message, options) {
    const capability = 'normalizeAssistantTextToToolCallsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const baseMessage = message && typeof message === 'object' ? { ...message } : {};
    const payloadJson = safeStringify(baseMessage);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        let normalizedMessage = { ...baseMessage };
        let toolCallsSource = [];
        if (Array.isArray(parsed)) {
            toolCallsSource = parsed;
        }
        else if (parsed && typeof parsed === 'object') {
            const row = parsed;
            const messageNode = row.message && typeof row.message === 'object' && !Array.isArray(row.message)
                ? row.message
                : row;
            normalizedMessage = {
                ...normalizedMessage,
                ...messageNode
            };
            toolCallsSource = Array.isArray(messageNode.tool_calls)
                ? messageNode.tool_calls
                : [];
        }
        else {
            return fail('invalid payload');
        }
        const normalizedCalls = normalizeToolCallEntries(toolCallsSource);
        if (normalizedCalls.length > 0) {
            return {
                ...normalizedMessage,
                tool_calls: normalizedCalls
            };
        }
        return normalizedMessage;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeReasoningInChatPayloadWithNative(payload) {
    const capability = 'normalizeReasoningInChatPayloadJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(payload ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseNormalizeReasoningOutput(raw);
        return parsed ? parsed.payload : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeReasoningInResponsesPayloadWithNative(payload, options) {
    const capability = 'normalizeReasoningInResponsesPayloadJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify({ payload: payload ?? null, options: options ?? {} });
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseNormalizeReasoningOutput(raw);
        return parsed ? parsed.payload : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeReasoningInGeminiPayloadWithNative(payload) {
    const capability = 'normalizeReasoningInGeminiPayloadJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(payload ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseNormalizeReasoningOutput(raw);
        return parsed ? parsed.payload : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeReasoningInAnthropicPayloadWithNative(payload) {
    const capability = 'normalizeReasoningInAnthropicPayloadJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(payload ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseNormalizeReasoningOutput(raw);
        return parsed ? parsed.payload : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeReasoningInOpenAIPayloadWithNative(payload) {
    const capability = 'normalizeReasoningInOpenaiPayloadJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(payload ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseNormalizeReasoningOutput(raw);
        return parsed ? parsed.payload : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function sanitizeReasoningTaggedTextWithNative(text) {
    const capability = 'sanitizeReasoningTaggedTextJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    try {
        const raw = fn(String(text ?? ''));
        if (typeof raw !== 'string') {
            return fail('invalid payload');
        }
        return raw;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-reasoning.js.map