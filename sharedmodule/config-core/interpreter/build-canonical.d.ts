import type { ParsedResult } from './loaders.js';
export interface BuildOptions {
    keyDimension?: 'perKey' | 'runtime' | 'explicit';
}
export interface CanonicalLike {
    providers: Record<string, any>;
    keyVault: Record<string, Record<string, any>>;
    pipelines: Array<{
        id: string;
        modules: any;
        authRef?: any;
        settings?: any;
    }>;
    routing: Record<string, string[]>;
    routeMeta: Record<string, {
        providerId: string;
        modelId: string;
        keyId?: string | null;
    }>;
    httpserver?: {
        port?: number;
        host?: string;
    };
    modules?: {
        httpserver?: {
            enabled?: boolean;
            config?: {
                port?: number;
                host?: string;
            };
        };
    };
    _metadata: Record<string, any>;
}
export declare function buildCanonical(system: ParsedResult, user: ParsedResult, options?: BuildOptions): CanonicalLike;
