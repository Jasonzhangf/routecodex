export type LlmsEngineShadowConfig = {
    enabled: boolean;
    sampleRate: number;
    shadowPrefixes: string[];
    dir: string;
};
export declare function resolveLlmsEngineShadowConfig(): LlmsEngineShadowConfig;
export declare function shouldRunLlmsEngineShadowForSubpath(config: LlmsEngineShadowConfig, subpath: string): boolean;
export declare function isLlmsEngineShadowEnabledForSubpath(config: LlmsEngineShadowConfig, subpath: string): boolean;
export declare function recordLlmsEngineShadowDiff(options: {
    group: 'hub-pipeline' | 'provider-response';
    requestId: string;
    subpath: string;
    baselineImpl: 'ts';
    candidateImpl: 'engine';
    baselineOut: unknown;
    candidateOut: unknown;
    excludedComparePaths?: string[];
}): Promise<void>;
