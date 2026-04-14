export function isNativeDisabledByEnv() {
    return false;
}
export function isNativeRequiredByEnv() {
    return true;
}
export function hasCompleteNativeBinding(binding, requiredExports) {
    if (!binding || typeof binding !== 'object')
        return false;
    const row = binding;
    return requiredExports.every((key) => typeof row[key] === 'function');
}
export function makeNativeRequiredError(capability, reason) {
    return new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable${reason ? `: ${reason}` : ''}`);
}
export function failNativeRequired(capability, reason) {
    throw makeNativeRequiredError(capability, reason);
}
//# sourceMappingURL=native-router-hotpath-policy.js.map