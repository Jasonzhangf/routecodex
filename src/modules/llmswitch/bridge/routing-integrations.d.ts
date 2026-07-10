/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor.
 */
import type { AnyRecord } from './module-loader.js';
export declare function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord>;
export declare function compileRouteCodexRuntimeManifest(input: AnyRecord): Promise<AnyRecord>;
export declare function compileRouteCodexRuntimeManifestSync(input: AnyRecord): AnyRecord;
export declare function collectRouteCodexV2ConfigSourceErrorsSync(userConfig: AnyRecord): string[];
export declare function normalizeRouteCodexV2RuntimeSourceSync(userConfig: AnyRecord): AnyRecord;
export declare function resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig: AnyRecord): string | undefined;
export declare function extractRouteCodexMaterializedProviderConfigsSync(userConfig: AnyRecord): AnyRecord | null;
export declare function materializeRouteCodexUserConfigFromManifestSync(userConfig: AnyRecord, manifest: AnyRecord): AnyRecord;
export declare function buildRouteCodexProviderProfilesSync(userConfig: AnyRecord): AnyRecord;
export declare function buildRouteCodexForwarderProfilesSync(userConfig: AnyRecord, knownProviderIds: Set<string> | string[]): AnyRecord;
export declare function parseRouteCodexTomlRecord(raw: string): Promise<AnyRecord>;
export declare function parseRouteCodexTomlRecordSync(raw: string): AnyRecord;
export declare function serializeRouteCodexTomlRecord(record: AnyRecord): Promise<string>;
export declare function serializeRouteCodexTomlRecordSync(record: AnyRecord): string;
export declare function updateRouteCodexTomlStringScalarInTable(input: {
    raw: string;
    tablePath: string[];
    key: string;
    value: string;
}): Promise<string>;
export declare function updateRouteCodexTomlStringScalarInTableSync(input: {
    raw: string;
    tablePath: string[];
    key: string;
    value: string;
}): string;
export declare function decodeRouteCodexUserConfigTextSync(input: {
    raw: string;
    configPath?: string;
}): {
    format: 'toml';
    parsed: AnyRecord;
};
export declare function decodeRouteCodexProviderConfigTextSync(input: {
    raw: string;
    configPath?: string;
}): {
    format: 'toml';
    parsed: AnyRecord;
};
export declare function detectRouteCodexUserConfigFormatSync(configPath: string): 'toml';
export declare function detectRouteCodexProviderConfigFormatSync(configPath: string): 'toml';
export declare function writeRouteCodexUserConfigFileNativeSync(input: {
    configPath: string;
    parsed: AnyRecord;
    format?: 'toml';
}): {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
};
export declare function writeRouteCodexProviderConfigFileNativeSync(input: {
    configPath: string;
    parsed: AnyRecord;
    format?: 'toml';
}): {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
};
export declare function updateRouteCodexUserConfigStringScalarNativeSync(input: {
    configPath: string;
    tablePath: string[];
    key: string;
    value: string;
}): {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
};
export declare function loadRouteCodexConfigNativeSync(input?: {
    explicitPath?: string;
    routecodexProviderDir?: string;
    rccProviderDir?: string;
}): {
    configPath: string;
    userConfig: AnyRecord;
    providerProfiles: AnyRecord;
};
export declare function coerceRouteCodexProviderConfigV2(parsed: AnyRecord, fallbackProviderId?: string): Promise<AnyRecord | null>;
export declare function coerceRouteCodexProviderConfigV2Sync(parsed: AnyRecord, fallbackProviderId?: string): AnyRecord | null;
export declare function planRouteCodexProviderConfigV2FilesSync(fileNames: string[]): Array<{
    fileName: string;
    isBaseFile: boolean;
}>;
export declare function resolveRouteCodexProviderConfigV2IdentitySync(input: {
    dirId: string;
    fileName: string;
    filePath: string;
    isBaseFile: boolean;
    parsed: AnyRecord;
    provider: AnyRecord;
}): {
    providerId: string;
    provider: AnyRecord;
};
export declare function loadRouteCodexProviderConfigsV2FromRootSync(rootDir: string): Record<string, AnyRecord>;
export declare function resolveRccUserDirNativeSync(homeDir?: string): string;
export declare function resolveRccPathNativeSync(segments: string[], homeDir?: string): string;
export declare function resolveRccSnapshotsDirNativeSync(homeDir?: string): string;
export declare function planAuthFileResolutionNativeSync(input: {
    keyId: string;
    authDir?: string;
    homeDir?: string;
}): {
    kind: 'literal' | 'authFile';
    value?: string;
    filePath?: string;
    cacheKey?: string;
};
export declare function resolveAuthFileKeyNativeSync(input: {
    keyId: string;
    authDir?: string;
    homeDir?: string;
}): {
    kind: 'literal' | 'authFile';
    value: string;
    cacheKey?: string;
};
export declare function planRouteCodexConfigLoaderPathsNativeSync(input: {
    explicitPath?: string;
    routecodexProviderDir?: string;
    rccProviderDir?: string;
}): {
    explicitPath?: string;
    providerRootDir?: string;
};
export declare function planProviderConfigRootNativeSync(rootDir?: string): {
    rootDir?: string;
};
export declare function resolveRouteCodexConfigPathNativeSync(options?: {
    preferredPath?: string;
    configName?: string;
    allowDirectoryScan?: boolean;
    baseDir?: string;
}): string;
export declare function createHubPipelineNative(config: AnyRecord): string;
export declare function executeHubPipelineNative(handle: string, request: AnyRecord): AnyRecord;
export declare function updateHubPipelineVirtualRouterConfigNative(handle: string, config: AnyRecord): void;
export declare function updateHubPipelineEngineDepsNative(handle: string, deps: AnyRecord): void;
export declare function routeHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord;
export declare function diagnoseHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord;
export declare function getHubPipelineVirtualRouterStatusNative(handle: string): AnyRecord;
export declare function markHubPipelineVirtualRouterConcurrencyScopeBusyNative(handle: string, scopeKey: string): void;
export declare function markHubPipelineVirtualRouterConcurrencyScopeIdleNative(handle: string, scopeKey: string): void;
export declare function disposeHubPipelineNative(handle: string): void;
