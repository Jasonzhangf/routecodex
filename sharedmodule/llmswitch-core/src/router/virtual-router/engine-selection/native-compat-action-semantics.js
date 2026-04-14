import { failNativeRequired, isNativeDisabledByEnv, } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
function readNativeFunction(name) {
    const binding = loadNativeRouterHotpathBindingForInternalUse();
    const fn = binding?.[name];
    return typeof fn === 'function'
        ? fn
        : null;
}
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
function parseRecord(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function invokeRecordCapability(capability, args) {
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv())
        return fail('native disabled');
    const fn = readNativeFunction(capability);
    if (!fn)
        return fail();
    const encodedArgs = [];
    for (const arg of args) {
        const encoded = safeStringify(arg);
        if (!encoded)
            return fail('json stringify failed');
        encodedArgs.push(encoded);
    }
    try {
        const raw = fn(...encodedArgs);
        if (typeof raw !== 'string' || !raw)
            return fail('empty result');
        const parsed = parseRecord(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
function invokeVoidCapability(capability, args) {
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv())
        return fail('native disabled');
    const fn = readNativeFunction(capability);
    if (!fn)
        return fail();
    const encodedArgs = [];
    for (const arg of args) {
        const encoded = safeStringify(arg);
        if (!encoded)
            return fail('json stringify failed');
        encodedArgs.push(encoded);
    }
    try {
        fn(...encodedArgs);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        throw new Error(reason);
    }
}
export function normalizeResponsePayloadWithNative(payload, config) {
    return invokeRecordCapability('normalizeResponsePayloadJson', [
        payload,
        config ?? {},
    ]);
}
export function validateResponsePayloadWithNative(payload) {
    invokeVoidCapability('validateResponsePayloadJson', [payload]);
}
export function applyRequestRulesWithNative(payload, config) {
    return invokeRecordCapability('applyRequestRulesJson', [payload, config ?? {}]);
}
export function applyFieldMappingsWithNative(payload, mappings) {
    return invokeRecordCapability('applyFieldMappingsJson', [
        payload,
        Array.isArray(mappings) ? mappings : [],
    ]);
}
export function sanitizeToolSchemaGlmShellWithNative(payload) {
    return invokeRecordCapability('sanitizeToolSchemaGlmShellJson', [payload]);
}
export function fixApplyPatchToolCallsWithNative(payload) {
    const parsed = invokeRecordCapability('fixApplyPatchToolCallsJson', [
        {
            messages: Array.isArray(payload?.messages) ? payload.messages : [],
            ...(Array.isArray(payload?.input) ? { input: payload.input } : {})
        },
    ]);
    const messages = Array.isArray(parsed.messages)
        ? parsed.messages.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        : [];
    const input = Array.isArray(parsed.input)
        ? parsed.input.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        : undefined;
    return {
        messages,
        ...(input ? { input } : {})
    };
}
export function applyResponseBlacklistWithNative(payload, config) {
    return invokeRecordCapability('applyResponseBlacklistJson', [
        payload,
        config ?? {},
    ]);
}
export function normalizeToolCallIdsWithNative(payload) {
    return invokeRecordCapability('normalizeToolCallIdsJson', [payload]);
}
export function enforceLmstudioResponsesFcToolCallIdsWithNative(payload) {
    return invokeRecordCapability('enforceLmstudioResponsesFcToolCallIdsJson', [
        payload,
    ]);
}
export function applyAnthropicClaudeCodeUserIdWithNative(payload, adapterContext) {
    return invokeRecordCapability('applyAnthropicClaudeCodeUserIdJson', [
        payload,
        adapterContext ?? {},
    ]);
}
export function applyGeminiWebSearchRequestCompatWithNative(payload, adapterContext) {
    return invokeRecordCapability('applyGeminiWebSearchRequestCompatJson', [
        payload,
        adapterContext ?? {},
    ]);
}
export function prepareAntigravityThoughtSignatureForGeminiRequestWithNative(payload, adapterContext) {
    return invokeRecordCapability('prepareAntigravityThoughtSignatureForGeminiRequestJson', [payload, adapterContext ?? {}]);
}
export function applyIflowToolTextFallbackWithNative(payload, adapterContext, models) {
    return invokeRecordCapability('applyIflowToolTextFallbackJson', [
        payload,
        adapterContext ?? {},
        Array.isArray(models) ? models : [],
    ]);
}
export function applyLmstudioResponsesInputStringifyWithNative(payload, adapterContext) {
    return invokeRecordCapability('applyLmstudioResponsesInputStringifyJson', [
        payload,
        adapterContext ?? {},
    ]);
}
export function applyToolTextRequestGuidanceWithNative(payload, config) {
    return invokeRecordCapability('applyToolTextRequestGuidanceJson', [
        payload,
        config ?? {},
    ]);
}
export function harvestToolCallsFromTextWithNative(payload, options) {
    return invokeRecordCapability('harvestToolCallsFromTextJson', [
        payload,
        options ?? {},
    ]);
}
export function applyUniversalShapeRequestFilterWithNative(payload, config) {
    return invokeRecordCapability('applyUniversalShapeRequestFilterJson', [
        payload,
        config ?? {},
    ]);
}
export function applyUniversalShapeResponseFilterWithNative(payload, config, adapterContext) {
    return invokeRecordCapability('applyUniversalShapeResponseFilterJson', [
        payload,
        config ?? {},
        adapterContext ?? {},
    ]);
}
export function buildOpenAIChatFromAnthropicWithNative(payload, options) {
    return invokeRecordCapability('buildOpenaiChatFromAnthropicJson', [
        payload,
        options ?? {},
    ]);
}
export function buildAnthropicFromOpenAIChatWithNative(payload, options) {
    return invokeRecordCapability('buildAnthropicFromOpenaiChatJson', [
        payload,
        options ?? {},
    ]);
}
export function runOpenAIRequestCodecWithNative(payload, options) {
    return invokeRecordCapability('runOpenaiOpenaiRequestCodecJson', [
        payload,
        options ?? {},
    ]);
}
export function runOpenAIResponseCodecWithNative(payload, options) {
    return invokeRecordCapability('runOpenaiOpenaiResponseCodecJson', [
        payload,
        options ?? {},
    ]);
}
export function runResponsesOpenAIRequestCodecWithNative(payload, options) {
    return invokeRecordCapability('runResponsesOpenaiRequestCodecJson', [
        payload,
        options ?? {},
    ]);
}
export function runResponsesOpenAIResponseCodecWithNative(payload, context) {
    return invokeRecordCapability('runResponsesOpenaiResponseCodecJson', [
        payload,
        context,
    ]);
}
export function runGeminiOpenAIRequestCodecWithNative(payload, options) {
    return invokeRecordCapability('runGeminiOpenaiRequestCodecJson', [
        payload,
        options ?? {},
    ]);
}
export function runGeminiOpenAIResponseCodecWithNative(payload, options) {
    return invokeRecordCapability('runGeminiOpenaiResponseCodecJson', [
        payload,
        options ?? {},
    ]);
}
export function runGeminiFromOpenAIChatCodecWithNative(payload, options) {
    return invokeRecordCapability('runGeminiFromOpenaiChatCodecJson', [
        payload,
        options ?? {},
    ]);
}
//# sourceMappingURL=native-compat-action-semantics.js.map