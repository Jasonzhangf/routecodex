export declare function normalizeFunctionCallIdWithNative(input: {
    callId?: string;
    fallback?: string;
}): string;
export declare function normalizeFunctionCallOutputIdWithNative(input: {
    callId?: string;
    fallback?: string;
}): string;
export declare function normalizeResponsesCallIdWithNative(input: {
    callId?: string;
    fallback?: string;
}): string;
export declare function clampResponsesInputItemIdWithNative(rawValue: unknown): string | undefined;
