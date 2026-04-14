export declare function isNativeDisabledByEnv(): boolean;
export declare function isNativeRequiredByEnv(): boolean;
export declare function hasCompleteNativeBinding(binding: unknown, requiredExports: readonly string[]): boolean;
export declare function makeNativeRequiredError(capability: string, reason?: string): Error;
export declare function failNativeRequired<T>(capability: string, reason?: string): T;
