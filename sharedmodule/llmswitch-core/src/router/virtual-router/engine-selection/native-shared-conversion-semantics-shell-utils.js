import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, parseRecord, parseStringArray, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function repairFindMetaWithNative(script) {
    const capability = 'repairFindMetaJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(script ?? '');
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        return typeof parsed === 'string' ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function splitCommandStringWithNative(input) {
    const capability = 'splitCommandStringJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(input ?? '');
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseStringArray(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function packShellArgsWithNative(input) {
    const capability = 'packShellArgsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(input ?? {});
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
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
export function flattenByCommaWithNative(items) {
    const capability = 'flattenByCommaJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(Array.isArray(items) ? items : []);
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseStringArray(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function chunkStringWithNative(s, minParts = 3, maxParts = 12, targetChunk = 12) {
    const capability = 'chunkStringJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify({ s, minParts, maxParts, targetChunk });
    if (!payloadJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(payloadJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseStringArray(raw);
        return parsed ?? fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function deriveToolCallKeyWithNative(call) {
    const capability = 'deriveToolCallKeyJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const callJson = safeStringify(call ?? null);
    if (!callJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(callJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return null;
        }
        return typeof parsed === 'string' ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-shell-utils.js.map