export type NativeRouterHotpathBinding = {
    [name: string]: unknown;
};
export declare function loadNativeRouterHotpathBinding(): NativeRouterHotpathBinding | null;
export declare function resolveNativeModuleUrlFromEnv(): string | undefined;
export declare const VIRTUAL_ROUTER_ERROR_PREFIX = "VIRTUAL_ROUTER_ERROR:";
export declare function extractVirtualRouterNativeErrorMessage(error: unknown): string;
export declare function parseVirtualRouterNativeErrorPayload(message: string): {
    code: string;
    message: string;
    details?: Record<string, unknown>;
} | null;
export declare function parseVirtualRouterNativeError(error: unknown): Error | null;
