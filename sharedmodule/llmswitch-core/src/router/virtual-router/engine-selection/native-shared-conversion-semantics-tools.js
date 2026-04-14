import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function injectMcpToolsForChatWithNative(tools, discoveredServers) {
    const capability = 'injectMcpToolsForChatJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
    const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
    if (!toolsJson || !serversJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(toolsJson, serversJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        return Array.isArray(parsed) ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeArgsBySchemaWithNative(input, schema) {
    const capability = 'normalizeArgsBySchemaJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const inputJson = safeStringify(input ?? null);
    const schemaJson = safeStringify(schema ?? null);
    if (!inputJson || !schemaJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(inputJson, schemaJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed || typeof parsed.ok !== 'boolean') {
            return fail('invalid payload');
        }
        const out = {
            ok: parsed.ok
        };
        if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
            out.value = parsed.value;
        }
        if (Array.isArray(parsed.errors)) {
            out.errors = parsed.errors.filter((entry) => typeof entry === 'string');
        }
        return out;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeOpenaiChatMessagesWithNative(messages) {
    const capability = 'normalizeOpenaiChatMessagesJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(messages ?? null);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        return Array.isArray(parsed) ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeOpenaiToolCallWithNative(toolCall, disableShellCoerce) {
    const capability = 'normalizeOpenaiToolCallJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(toolCall ?? null);
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
export function prepareGeminiToolsForBridgeWithNative(rawTools, missing) {
    const capability = 'prepareGeminiToolsForBridgeJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const rawToolsJson = safeStringify(rawTools ?? null);
    const missingJson = safeStringify(Array.isArray(missing) ? missing : []);
    if (!rawToolsJson || !missingJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(rawToolsJson, missingJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const defs = Array.isArray(parsed.defs)
            ? parsed.defs.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            : undefined;
        const nextMissing = Array.isArray(parsed.missing)
            ? parsed.missing.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            : [];
        return {
            ...(defs && defs.length ? { defs } : {}),
            missing: nextMissing
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function buildGeminiToolsFromBridgeWithNative(defs, mode = 'default') {
    const capability = 'buildGeminiToolsFromBridgeJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const defsJson = safeStringify(defs ?? null);
    if (!defsJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(defsJson, mode);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed == null) {
            return undefined;
        }
        if (!Array.isArray(parsed)) {
            return fail('invalid payload');
        }
        return parsed.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry));
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function injectMcpToolsForResponsesWithNative(tools, discoveredServers) {
    const capability = 'injectMcpToolsForResponsesJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
    const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
    if (!toolsJson || !serversJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(toolsJson, serversJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        return Array.isArray(parsed) ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-tools.js.map