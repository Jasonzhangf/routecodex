import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function encodeMetadataPassthroughWithNative(parameters, prefix, keys) {
    const capability = 'encodeMetadataPassthroughJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const parametersJson = safeStringify(parameters ?? null);
    const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
    if (!parametersJson || !keysJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(parametersJson, String(prefix || ''), keysJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return fail('invalid payload');
        }
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof key !== 'string' || typeof value !== 'string') {
                return fail('invalid payload');
            }
            out[key] = value;
        }
        return Object.keys(out).length ? out : undefined;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function extractMetadataPassthroughWithNative(metadataField, prefix, keys) {
    const capability = 'extractMetadataPassthroughJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const metadataJson = safeStringify(metadataField ?? null);
    const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
    if (!metadataJson || !keysJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(metadataJson, String(prefix || ''), keysJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const metadata = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
            ? parsed.metadata
            : undefined;
        const passthrough = parsed.passthrough && typeof parsed.passthrough === 'object' && !Array.isArray(parsed.passthrough)
            ? parsed.passthrough
            : undefined;
        return {
            ...(metadata ? { metadata } : {}),
            ...(passthrough ? { passthrough } : {})
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function ensureProtocolStateWithNative(metadata, protocol) {
    const capability = 'ensureProtocolStateJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const metadataJson = safeStringify(metadata ?? {});
    if (!metadataJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(metadataJson, String(protocol ?? ''));
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        if (!parsed) {
            return fail('invalid payload');
        }
        const metadataOut = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
            ? parsed.metadata
            : undefined;
        const nodeOut = parsed.node && typeof parsed.node === 'object' && !Array.isArray(parsed.node)
            ? parsed.node
            : undefined;
        if (!metadataOut || !nodeOut) {
            return fail('invalid payload');
        }
        return { metadata: metadataOut, node: nodeOut };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function getProtocolStateWithNative(metadata, protocol) {
    const capability = 'getProtocolStateJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const metadataJson = safeStringify(metadata ?? null);
    if (!metadataJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(metadataJson, String(protocol ?? ''));
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return undefined;
        }
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function readRuntimeMetadataWithNative(carrier) {
    const capability = 'readRuntimeMetadataJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const carrierJson = safeStringify(carrier ?? null);
    if (!carrierJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(carrierJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return undefined;
        }
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function ensureRuntimeMetadataCarrierWithNative(carrier) {
    const capability = 'ensureRuntimeMetadataJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const carrierJson = safeStringify(carrier);
    if (!carrierJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(carrierJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseRecord(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function cloneRuntimeMetadataWithNative(carrier) {
    const capability = 'cloneRuntimeMetadataJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const carrierJson = safeStringify(carrier ?? null);
    if (!carrierJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(carrierJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return undefined;
        }
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-metadata.js.map