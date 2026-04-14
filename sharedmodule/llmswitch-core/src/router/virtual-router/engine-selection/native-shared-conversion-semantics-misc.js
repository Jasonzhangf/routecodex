import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function parseLenientJsonishWithNative(value) {
    const capability = 'parseLenientJsonishJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const valueJson = safeStringify(value ?? null);
    if (!valueJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(valueJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        return parsed === null ? fail('invalid payload') : parsed;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function repairArgumentsToStringWithNative(value) {
    const capability = 'repairArgumentsToStringJsonishJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const valueJson = safeStringify(value ?? null);
    if (!valueJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(valueJson);
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
export function ensureBridgeInstructionsWithNative(payload) {
    const capability = 'ensureBridgeInstructionsJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const payloadJson = safeStringify(payload ?? {});
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
//# sourceMappingURL=native-shared-conversion-semantics-misc.js.map