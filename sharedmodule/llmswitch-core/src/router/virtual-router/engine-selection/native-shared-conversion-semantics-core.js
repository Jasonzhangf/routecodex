import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
export function readNativeFunction(name) {
    const binding = loadNativeRouterHotpathBindingForInternalUse();
    const fn = binding?.[name];
    return typeof fn === 'function' ? fn : null;
}
export function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
export function parseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function parseRecord(raw) {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    return parsed;
}
export function parseArray(raw) {
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : null;
}
export function parseString(raw) {
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : null;
}
export function parseStringArray(raw) {
    const parsed = parseArray(raw);
    if (!parsed) {
        return null;
    }
    const out = [];
    for (const item of parsed) {
        if (typeof item !== 'string') {
            return null;
        }
        out.push(item);
    }
    return out;
}
//# sourceMappingURL=native-shared-conversion-semantics-core.js.map