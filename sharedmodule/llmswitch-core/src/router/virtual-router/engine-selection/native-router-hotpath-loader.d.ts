import { VirtualRouterError, VirtualRouterErrorCode } from "../types.js";
export type NativeRouterHotpathBinding = {
    [name: string]: unknown;
};
export declare const VIRTUAL_ROUTER_ERROR_PREFIX = "VIRTUAL_ROUTER_ERROR:";
type ParsedVirtualRouterNativeError = {
    code: VirtualRouterErrorCode;
    message: string;
    details?: Record<string, unknown>;
};
export declare function loadNativeRouterHotpathBinding(): NativeRouterHotpathBinding | null;
export declare function resolveNativeModuleUrlFromEnv(): string | undefined;
export declare function extractVirtualRouterNativeErrorMessage(error: unknown): string;
export declare function parseVirtualRouterNativeErrorPayload(message: string): ParsedVirtualRouterNativeError | null;
export declare function parseVirtualRouterNativeError(error: unknown): VirtualRouterError | null;
export {};
