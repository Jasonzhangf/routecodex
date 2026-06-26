function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/**
 * Removes keys that start with "__" from any object/array tree.
 * Intended for enforcing the E1 boundary rule (no internal env vars reach client/provider payloads).
 */
export function stripInternalKeysDeep(value, options = {}) {
    const preserve = options.preserveKeys ?? new Set();
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripInternalKeysDeep(item, options));
    }
    if (!isPlainObject(value)) {
        return value;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key.startsWith('__') && !preserve.has(key)) {
            continue;
        }
        out[key] = stripInternalKeysDeep(entry, options);
    }
    return out;
}
