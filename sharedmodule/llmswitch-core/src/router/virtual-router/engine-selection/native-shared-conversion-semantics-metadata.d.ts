export declare function encodeMetadataPassthroughWithNative(parameters: unknown, prefix: string, keys: readonly string[]): Record<string, string> | undefined;
export declare function extractMetadataPassthroughWithNative(metadataField: unknown, prefix: string, keys: readonly string[]): {
    metadata?: Record<string, unknown>;
    passthrough?: Record<string, unknown>;
};
export declare function ensureProtocolStateWithNative(metadata: Record<string, unknown>, protocol: string): {
    metadata: Record<string, unknown>;
    node: Record<string, unknown>;
};
export declare function getProtocolStateWithNative(metadata: Record<string, unknown> | undefined, protocol: string): Record<string, unknown> | undefined;
export declare function readRuntimeMetadataWithNative(carrier: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined;
export declare function ensureRuntimeMetadataCarrierWithNative(carrier: Record<string, unknown>): Record<string, unknown>;
export declare function cloneRuntimeMetadataWithNative(carrier: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined;
