import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';
export function normalizeFunctionCallIdWithNative(input) {
    const capability = 'normalizeFunctionCallIdJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const inputJson = safeStringify(input ?? {});
    if (!inputJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(inputJson);
        return typeof raw === 'string' && raw ? raw : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeFunctionCallOutputIdWithNative(input) {
    const capability = 'normalizeFunctionCallOutputIdJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const inputJson = safeStringify(input ?? {});
    if (!inputJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(inputJson);
        return typeof raw === 'string' && raw ? raw : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function normalizeResponsesCallIdWithNative(input) {
    const capability = 'normalizeResponsesCallIdJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const inputJson = safeStringify(input ?? {});
    if (!inputJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(inputJson);
        return typeof raw === 'string' && raw ? raw : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
export function clampResponsesInputItemIdWithNative(rawValue) {
    const capability = 'clampResponsesInputItemIdJson';
    const fail = (reason) => failNativeRequired(capability, reason);
    if (isNativeDisabledByEnv()) {
        return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
        return fail();
    }
    const rawJson = safeStringify(rawValue ?? null);
    if (!rawJson) {
        return fail('json stringify failed');
    }
    try {
        const raw = fn(rawJson);
        if (typeof raw !== 'string' || !raw) {
            return fail('empty result');
        }
        const parsed = parseJson(raw);
        if (parsed === null) {
            return undefined;
        }
        return typeof parsed === 'string' ? parsed : fail('invalid payload');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
        return fail(reason);
    }
}
//# sourceMappingURL=native-shared-conversion-semantics-call-id.js.map