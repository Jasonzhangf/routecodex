import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseArray, parseJson, parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
function parseToolCallLiteArray(raw) {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
        return null;
    }
    const out = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
        }
        const row = entry;
        if (typeof row.name !== 'string' || typeof row.args !== 'string') {
            return null;
        }
        const id = typeof row.id === 'string' && row.id.trim().length ? row.id : undefined;
        out.push({ id, name: row.name, args: row.args });
    }
    return out;
}
function parseReasoningItems(raw) {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
        return null;
    }
    const out = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
        }
        const row = entry;
        if (row.type !== 'reasoning' || typeof row.content !== 'string') {
            return null;
        }
        out.push({ type: 'reasoning', content: row.content });
    }
    return out;
}
function parseToolCallResult(raw) {
    if (!raw || raw === 'null') {
        return null;
    }
    return parseToolCallLiteArray(raw);
}
function callTextMarkupExtractor(capability, payload) {
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
        if (typeof raw !== 'string') {
            return fail('invalid payload');
        }
        const parsed = parseToolCallResult(raw);
        return parsed ?? null;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function extractJsonToolCallsFromTextWithNative(text, options) {
    return callTextMarkupExtractor('extractJsonToolCallsFromTextJson', {
        text: String(text ?? ''),
        options: options ?? null
    });
}
export function extractXMLToolCallsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractXmlToolCallsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractSimpleXmlToolsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractSimpleXmlToolsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractParameterXmlToolsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractParameterXmlToolsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractInvokeToolsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractInvokeToolsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractToolNamespaceXmlBlocksFromTextWithNative(text) {
    return callTextMarkupExtractor('extractToolNamespaceXmlBlocksFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractApplyPatchCallsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractApplyPatchCallsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractBareExecCommandFromTextWithNative(text) {
    return callTextMarkupExtractor('extractBareExecCommandFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractExecuteBlocksFromTextWithNative(text) {
    return callTextMarkupExtractor('extractExecuteBlocksFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractExploredListDirectoryCallsFromTextWithNative(text) {
    return callTextMarkupExtractor('extractExploredListDirectoryCallsFromTextJson', {
        text: String(text ?? '')
    });
}
export function extractQwenToolCallTokensFromTextWithNative(text) {
    return callTextMarkupExtractor('extractQwenToolCallTokensFromTextJson', {
        text: String(text ?? '')
    });
}
export function mergeToolCallsWithNative(existing, additions) {
    const capability = 'mergeToolCallsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const existingJson = safeStringify(existing ?? []);
    const additionsJson = safeStringify(additions ?? []);
    if (!existingJson || !additionsJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(existingJson, additionsJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (!Array.isArray(parsed)) {
            return fail('invalid payload');
        }
        return parsed.filter((entry) => entry && typeof entry === 'object');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function mapReasoningContentToResponsesOutputWithNative(reasoningContent) {
    const capability = 'mapReasoningContentToResponsesOutputJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const contentJson = safeStringify(reasoningContent ?? null);
    if (!contentJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(contentJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseReasoningItems(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function validateToolArgumentsWithNative(toolName, args) {
    const capability = 'validateToolArgumentsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify({ toolName, args: args ?? null });
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed || typeof parsed.repaired !== 'string' || typeof parsed.success !== 'boolean') {
            return fail('invalid payload');
        }
        const error = typeof parsed.error === 'string' ? parsed.error : undefined;
        return { repaired: parsed.repaired, success: parsed.success, ...(error ? { error } : {}) };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function repairToolCallsWithNative(toolCalls) {
    const capability = 'repairToolCallsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseArray(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        return parsed.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.arguments === 'string');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-toolcalls.js.map