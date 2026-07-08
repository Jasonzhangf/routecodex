/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */

import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolveCorePackageDir } from '../core-loader.js';
import { importCoreDist, requireCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';

type NativeHubPipelineOrchestrationSemantics = {
  createHubPipelineEngineJson?: (inputJson: string) => string;
  disposeHubPipelineEngineJson?: (handle: string) => void;
  hubPipelineExecuteJson?: (handle: string, requestJson: string) => string;
  updateHubPipelineEngineDepsJson?: (handle: string, depsJson: string) => void;
  updateHubPipelineVirtualRouterConfigJson?: (handle: string, configJson: string) => void;
  hubPipelineVirtualRouterRouteJson?: (handle: string, requestJson: string, metadataJson: string) => string;
  hubPipelineVirtualRouterDiagnoseRouteJson?: (handle: string, requestJson: string, metadataJson: string) => string;
  hubPipelineVirtualRouterStatusJson?: (handle: string) => string;
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson?: (handle: string, scopeKey: string) => void;
  hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson?: (handle: string, scopeKey: string) => void;
};

type VirtualRouterRouteHostEffectsModule = {
  createVirtualRouterRouteHostEffects?: (args: {
    request: AnyRecord;
    metadata: AnyRecord;
  }) => {
    finalize: (
      result: { target: AnyRecord; decision: AnyRecord },
      getStopMessageState: (metadata: AnyRecord) => unknown
    ) => void;
  };
  injectVirtualRouterRuntimeMetadata?: (metadata: AnyRecord) => AnyRecord;
};

let cachedNativeHubPipelineOrchestrationSemantics:
  | NativeHubPipelineOrchestrationSemantics
  | null = null;
let cachedVirtualRouterRouteHostEffectsModule:
  | VirtualRouterRouteHostEffectsModule
  | null = null;

function getNativeHubPipelineOrchestrationSemantics(): NativeHubPipelineOrchestrationSemantics {
  if (!cachedNativeHubPipelineOrchestrationSemantics) {
    cachedNativeHubPipelineOrchestrationSemantics =
      requireCoreDist<NativeHubPipelineOrchestrationSemantics>(
        'native/router-hotpath/native-hub-pipeline-orchestration-semantics'
      );
  }
  return cachedNativeHubPipelineOrchestrationSemantics;
}

function getVirtualRouterRouteHostEffectsModule(): VirtualRouterRouteHostEffectsModule {
  if (!cachedVirtualRouterRouteHostEffectsModule) {
    cachedVirtualRouterRouteHostEffectsModule =
      requireCoreDist<VirtualRouterRouteHostEffectsModule>('runtime/virtual-router-host-effects');
  }
  return cachedVirtualRouterRouteHostEffectsModule;
}

function requireNativeHubPipelineFn<T extends Function>(
  name: keyof NativeHubPipelineOrchestrationSemantics
): T {
  const fn = getNativeHubPipelineOrchestrationSemantics()[name];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${String(name)} not available`);
  }
  return fn as unknown as T;
}

function getImportMetaUrlUnsafe(): string | undefined {
  try {
    return Function('return import.meta.url')() as string | undefined;
  } catch {
    return undefined;
  }
}

const nodeRequire = createRequire(getImportMetaUrlUnsafe() || path.join(process.cwd(), 'package.json'));

function parseNativeJsonResult(raw: unknown): unknown {
  const text = String(raw);
  if (text.startsWith('Error: ')) {
    throw new Error(text.slice('Error: '.length));
  }
  return JSON.parse(text) as unknown;
}

function parseHubPipelineNativeJsonResult(raw: unknown, label: string): AnyRecord {
  const text = String(raw);
  if (text.startsWith('Error: ')) {
    throw new Error(text.slice('Error: '.length));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] ${label} returned invalid payload: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[llmswitch-bridge] ${label} returned non-object payload`);
  }
  return parsed as AnyRecord;
}

type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: AnyRecord) => AnyRecord;
};


export async function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<VirtualRouterBootstrapModule>('native/router-hotpath/native-virtual-router-bootstrap-config');
  const fn = mod.bootstrapVirtualRouterConfig;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] bootstrapVirtualRouterConfig not available');
  }
  return fn(input);
}

export async function compileRouteCodexRuntimeManifest(input: AnyRecord): Promise<AnyRecord> {
  return compileRouteCodexRuntimeManifestSync(input);
}

export function compileRouteCodexRuntimeManifestSync(input: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.compileRouteCodexRuntimeManifestJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] compileRouteCodexRuntimeManifestJson not available');
  }
  const raw = String(fn(JSON.stringify(input ?? {})));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid payload');
  }
  const manifest = output as AnyRecord;
  if (manifest.manifestVersion !== 'routecodex.runtime-config.v1' ||
      !manifest.virtualRouterBootstrapInput ||
      typeof manifest.virtualRouterBootstrapInput !== 'object' ||
      Array.isArray(manifest.virtualRouterBootstrapInput) ||
      !manifest.pipelineRuntimeConfig ||
      typeof manifest.pipelineRuntimeConfig !== 'object' ||
      Array.isArray(manifest.pipelineRuntimeConfig)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime config compiler returned invalid manifest');
  }
  return manifest;
}

export function collectRouteCodexV2ConfigSourceErrorsSync(userConfig: AnyRecord): string[] {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.collectRouteCodexV2ConfigSourceErrorsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] collectRouteCodexV2ConfigSourceErrorsJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid payload');
  }
  const errors = (output as AnyRecord).errors;
  if (!Array.isArray(errors) || !errors.every((item) => typeof item === 'string')) {
    throw new Error('[llmswitch-bridge] RouteCodex config source validator returned invalid errors');
  }
  return errors;
}

export function normalizeRouteCodexV2RuntimeSourceSync(userConfig: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.normalizeRouteCodexV2RuntimeSourceJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] normalizeRouteCodexV2RuntimeSourceJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid payload');
  }
  const normalized = (output as AnyRecord).userConfig;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('[llmswitch-bridge] RouteCodex runtime source normalizer returned invalid userConfig');
  }
  return normalized as AnyRecord;
}

export function resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig: AnyRecord): string | undefined {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolvePrimaryRouteCodexRoutingPolicyGroupJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolvePrimaryRouteCodexRoutingPolicyGroupJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid payload');
  }
  const group = (output as AnyRecord).routingPolicyGroup;
  if (group === null || typeof group === 'undefined') {
    return undefined;
  }
  if (typeof group !== 'string') {
    throw new Error('[llmswitch-bridge] RouteCodex routingPolicyGroup resolver returned invalid group');
  }
  return group;
}

export function extractRouteCodexMaterializedProviderConfigsSync(userConfig: AnyRecord): AnyRecord | null {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.extractRouteCodexMaterializedProviderConfigsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] extractRouteCodexMaterializedProviderConfigsJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({ userConfig: userConfig ?? {} })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid payload');
  }
  const providerConfigs = (output as AnyRecord).providerConfigs;
  if (providerConfigs === null || typeof providerConfigs === 'undefined') {
    return null;
  }
  if (!providerConfigs || typeof providerConfigs !== 'object' || Array.isArray(providerConfigs)) {
    throw new Error('[llmswitch-bridge] RouteCodex materialized provider extractor returned invalid providerConfigs');
  }
  return providerConfigs as AnyRecord;
}

export function materializeRouteCodexUserConfigFromManifestSync(userConfig: AnyRecord, manifest: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.materializeRouteCodexUserConfigFromManifestJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] materializeRouteCodexUserConfigFromManifestJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify({
    userConfig: userConfig ?? {},
    manifest: manifest ?? {}
  })))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid payload');
  }
  const materialized = (output as AnyRecord).userConfig;
  if (!materialized || typeof materialized !== 'object' || Array.isArray(materialized)) {
    throw new Error('[llmswitch-bridge] RouteCodex user config materializer returned invalid userConfig');
  }
  return materialized as AnyRecord;
}

export function buildRouteCodexProviderProfilesSync(userConfig: AnyRecord): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.buildRouteCodexProviderProfilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildRouteCodexProviderProfilesJson not available');
  }
  const raw = String(fn(JSON.stringify({ userConfig: userConfig ?? {} })));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid payload');
  }
  const providerProfiles = (output as AnyRecord).providerProfiles;
  if (!providerProfiles || typeof providerProfiles !== 'object' || Array.isArray(providerProfiles)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider profile builder returned invalid providerProfiles');
  }
  return providerProfiles as AnyRecord;
}

export function buildRouteCodexForwarderProfilesSync(userConfig: AnyRecord, knownProviderIds: Set<string> | string[]): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.buildRouteCodexForwarderProfilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildRouteCodexForwarderProfilesJson not available');
  }
  const providerIds = Array.isArray(knownProviderIds) ? knownProviderIds : Array.from(knownProviderIds ?? []);
  const raw = String(fn(JSON.stringify({ userConfig: userConfig ?? {}, knownProviderIds: providerIds })));
  if (raw.startsWith('Error:') || raw.startsWith('VIRTUAL_ROUTER_ERROR:')) {
    throw new Error(raw);
  }
  const output = JSON.parse(raw) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid payload');
  }
  const forwarderProfiles = (output as AnyRecord).forwarderProfiles;
  if (!forwarderProfiles || typeof forwarderProfiles !== 'object' || Array.isArray(forwarderProfiles)) {
    throw new Error('[llmswitch-bridge] RouteCodex forwarder profile builder returned invalid forwarderProfiles');
  }
  return forwarderProfiles as AnyRecord;
}

export async function parseRouteCodexTomlRecord(raw: string): Promise<AnyRecord> {
  return parseRouteCodexTomlRecordSync(raw);
}

export function parseRouteCodexTomlRecordSync(raw: string): AnyRecord {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.parseRouteCodexTomlRecordJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] parseRouteCodexTomlRecordJson not available');
  }
  return parseNativeTomlRecord(String(fn(String(raw ?? ''))));
}

export async function serializeRouteCodexTomlRecord(record: AnyRecord): Promise<string> {
  return serializeRouteCodexTomlRecordSync(record);
}

export function serializeRouteCodexTomlRecordSync(record: AnyRecord): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.serializeRouteCodexTomlRecordJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] serializeRouteCodexTomlRecordJson not available');
  }
  return String(fn(JSON.stringify(record ?? {})));
}

export async function updateRouteCodexTomlStringScalarInTable(input: {
  raw: string;
  tablePath: string[];
  key: string;
  value: string;
}): Promise<string> {
  return updateRouteCodexTomlStringScalarInTableSync(input);
}

export function updateRouteCodexTomlStringScalarInTableSync(input: {
  raw: string;
  tablePath: string[];
  key: string;
  value: string;
}): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.updateRouteCodexTomlStringScalarInTableJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateRouteCodexTomlStringScalarInTableJson not available');
  }
  return String(fn(JSON.stringify({
    raw: String(input.raw ?? ''),
    tablePath: Array.isArray(input.tablePath) ? input.tablePath.map(String) : [],
    key: String(input.key ?? ''),
    value: String(input.value ?? '')
  })));
}

export function decodeRouteCodexUserConfigTextSync(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.decodeRouteCodexUserConfigTextJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] decodeRouteCodexUserConfigTextJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    raw: String(input.raw ?? ''),
    ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
  }))) as unknown;
  return parseDecodedConfigTextOutput(output, 'user');
}

export function decodeRouteCodexProviderConfigTextSync(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.decodeRouteCodexProviderConfigTextJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] decodeRouteCodexProviderConfigTextJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    raw: String(input.raw ?? ''),
    ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
  }))) as unknown;
  return parseDecodedConfigTextOutput(output, 'provider');
}

export function detectRouteCodexUserConfigFormatSync(configPath: string): 'toml' {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.detectRouteCodexUserConfigFormatJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] detectRouteCodexUserConfigFormatJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ configPath: String(configPath ?? '') }))) as unknown;
  return parseDetectedConfigFormatOutput(output, 'user');
}

export function detectRouteCodexProviderConfigFormatSync(configPath: string): 'toml' {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.detectRouteCodexProviderConfigFormatJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] detectRouteCodexProviderConfigFormatJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ configPath: String(configPath ?? '') }))) as unknown;
  return parseDetectedConfigFormatOutput(output, 'provider');
}

function validatePersistedConfigFileOutput(output: unknown, label: string): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-bridge] ${label} writer returned invalid payload`);
  }
  const persisted = output as AnyRecord;
  if (
    typeof persisted.path !== 'string' ||
    persisted.format !== 'toml' ||
    typeof persisted.raw !== 'string' ||
    !persisted.parsed ||
    typeof persisted.parsed !== 'object' ||
    Array.isArray(persisted.parsed)
  ) {
    throw new Error(`[llmswitch-bridge] ${label} writer returned invalid shape`);
  }
  return persisted as {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
  };
}

export function writeRouteCodexUserConfigFileNativeSync(input: {
  configPath: string;
  parsed: AnyRecord;
  format?: 'toml';
}): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.writeRouteCodexUserConfigFileJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] writeRouteCodexUserConfigFileJson not available');
  }
  return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
    configPath: input.configPath,
    parsed: input.parsed ?? {},
    format: input.format
  }))), 'User config');
}

export function writeRouteCodexProviderConfigFileNativeSync(input: {
  configPath: string;
  parsed: AnyRecord;
  format?: 'toml';
}): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.writeRouteCodexProviderConfigFileJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] writeRouteCodexProviderConfigFileJson not available');
  }
  return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
    configPath: input.configPath,
    parsed: input.parsed ?? {},
    format: input.format
  }))), 'Provider config');
}

export function updateRouteCodexUserConfigStringScalarNativeSync(input: {
  configPath: string;
  tablePath: string[];
  key: string;
  value: string;
}): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.updateRouteCodexUserConfigStringScalarJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateRouteCodexUserConfigStringScalarJson not available');
  }
  return validatePersistedConfigFileOutput(parseNativeJsonResult(fn(JSON.stringify({
    configPath: input.configPath,
    tablePath: input.tablePath,
    key: input.key,
    value: input.value
  }))), 'User config scalar update');
}

export function loadRouteCodexConfigNativeSync(input: {
  explicitPath?: string;
  routecodexProviderDir?: string;
  rccProviderDir?: string;
} = {}): {
  configPath: string;
  userConfig: AnyRecord;
  providerProfiles: AnyRecord;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.loadRouteCodexConfigJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] loadRouteCodexConfigJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    explicitPath: input.explicitPath,
    routecodexProviderDir: input.routecodexProviderDir ?? process.env.ROUTECODEX_PROVIDER_DIR,
    rccProviderDir: input.rccProviderDir ?? process.env.RCC_PROVIDER_DIR,
    cwd: safeBridgeCwd(),
    homeDir: process.env.HOME,
    execPath: process.execPath,
    routecodexConfigPath: process.env.ROUTECODEX_CONFIG_PATH,
    routecodexConfig: process.env.ROUTECODEX_CONFIG,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex config loader returned invalid payload');
  }
  const loaded = output as AnyRecord;
  if (
    typeof loaded.configPath !== 'string' ||
    !loaded.userConfig ||
    typeof loaded.userConfig !== 'object' ||
    Array.isArray(loaded.userConfig) ||
    !loaded.providerProfiles ||
    typeof loaded.providerProfiles !== 'object' ||
    Array.isArray(loaded.providerProfiles)
  ) {
    throw new Error('[llmswitch-bridge] RouteCodex config loader returned invalid shape');
  }
  return loaded as {
    configPath: string;
    userConfig: AnyRecord;
    providerProfiles: AnyRecord;
  };
}

export async function coerceRouteCodexProviderConfigV2(
  parsed: AnyRecord,
  fallbackProviderId?: string
): Promise<AnyRecord | null> {
  return coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId);
}

export function coerceRouteCodexProviderConfigV2Sync(
  parsed: AnyRecord,
  fallbackProviderId?: string
): AnyRecord | null {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.coerceRouteCodexProviderConfigV2Json;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] coerceRouteCodexProviderConfigV2Json not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    parsed: parsed ?? {},
    fallbackProviderId: String(fallbackProviderId ?? '')
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid payload');
  }
  const config = (output as AnyRecord).config;
  if (config === null) {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config coercer returned invalid config');
  }
  return config as AnyRecord;
}

export function planRouteCodexProviderConfigV2FilesSync(fileNames: string[]): Array<{
  fileName: string;
  isBaseFile: boolean;
}> {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.planRouteCodexProviderConfigV2FilesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planRouteCodexProviderConfigV2FilesJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ fileNames }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid payload');
  }
  const files = (output as AnyRecord).files;
  if (!Array.isArray(files)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid files');
  }
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file entry');
    }
    const record = file as AnyRecord;
    if (typeof record.fileName !== 'string' || typeof record.isBaseFile !== 'boolean') {
      throw new Error('[llmswitch-bridge] RouteCodex provider config file planner returned invalid file shape');
    }
    return {
      fileName: record.fileName,
      isBaseFile: record.isBaseFile
    };
  });
}

export function resolveRouteCodexProviderConfigV2IdentitySync(input: {
  dirId: string;
  fileName: string;
  filePath: string;
  isBaseFile: boolean;
  parsed: AnyRecord;
  provider: AnyRecord;
}): { providerId: string; provider: AnyRecord } {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRouteCodexProviderConfigV2IdentityJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRouteCodexProviderConfigV2IdentityJson not available');
  }
  const output = JSON.parse(String(fn(JSON.stringify(input)))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid payload');
  }
  const record = output as AnyRecord;
  if (typeof record.providerId !== 'string' ||
      !record.provider ||
      typeof record.provider !== 'object' ||
      Array.isArray(record.provider)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config identity resolver returned invalid shape');
  }
  return {
    providerId: record.providerId,
    provider: record.provider as AnyRecord
  };
}

export function loadRouteCodexProviderConfigsV2FromRootSync(rootDir: string): Record<string, AnyRecord> {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.loadRouteCodexProviderConfigsV2FromRootJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] loadRouteCodexProviderConfigsV2FromRootJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ rootDir: String(rootDir ?? '') }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid payload');
  }
  const configs = (output as AnyRecord).configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error('[llmswitch-bridge] RouteCodex provider config root loader returned invalid configs');
  }
  return configs as Record<string, AnyRecord>;
}

export function resolveRccUserDirNativeSync(homeDir?: string): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRccUserDirJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRccUserDirJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME,
    ...(typeof homeDir === 'string' ? { homeDir } : {})
  }))) as unknown;
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-bridge] RouteCodex user dir resolver returned invalid path');
  }
  return output;
}

export function resolveRccPathNativeSync(segments: string[], homeDir?: string): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRccPathJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRccPathJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    segments: Array.isArray(segments) ? segments.map(String) : [],
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME,
    ...(typeof homeDir === 'string' ? { homeDir } : {})
  }))) as unknown;
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-bridge] RouteCodex path resolver returned invalid path');
  }
  return output;
}

export function resolveRccSnapshotsDirNativeSync(homeDir?: string): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRccSnapshotsDirJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRccSnapshotsDirJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    homeDir,
    rccSnapshotDir: process.env.RCC_SNAPSHOT_DIR,
    routecodexSnapshotDir: process.env.ROUTECODEX_SNAPSHOT_DIR,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex snapshots dir resolver returned invalid payload');
  }
  const snapshotsDir = (output as AnyRecord).snapshotsDir;
  if (typeof snapshotsDir !== 'string' || !snapshotsDir.trim()) {
    throw new Error('[llmswitch-bridge] RouteCodex snapshots dir resolver returned invalid path');
  }
  return snapshotsDir;
}

export function planAuthFileResolutionNativeSync(input: {
  keyId: string;
  authDir?: string;
  homeDir?: string;
}): {
  kind: 'literal' | 'authFile';
  value?: string;
  filePath?: string;
  cacheKey?: string;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.planAuthFileResolutionJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planAuthFileResolutionJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (plan.kind !== 'literal' && plan.kind !== 'authFile') {
    throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid kind');
  }
  if (plan.kind === 'literal' && typeof plan.value !== 'string') {
    throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid literal value');
  }
  if (plan.kind === 'authFile' &&
      (typeof plan.filePath !== 'string' || typeof plan.cacheKey !== 'string')) {
    throw new Error('[llmswitch-bridge] AuthFile resolver returned invalid authFile plan');
  }
  return plan as {
    kind: 'literal' | 'authFile';
    value?: string;
    filePath?: string;
    cacheKey?: string;
  };
}

export function resolveAuthFileKeyNativeSync(input: {
  keyId: string;
  authDir?: string;
  homeDir?: string;
}): {
  kind: 'literal' | 'authFile';
  value: string;
  cacheKey?: string;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveAuthFileKeyJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveAuthFileKeyJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid payload');
  }
  const resolved = output as AnyRecord;
  if ((resolved.kind !== 'literal' && resolved.kind !== 'authFile') || typeof resolved.value !== 'string') {
    throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid shape');
  }
  if (typeof resolved.cacheKey !== 'undefined' && typeof resolved.cacheKey !== 'string') {
    throw new Error('[llmswitch-bridge] AuthFile key resolver returned invalid cache key');
  }
  return resolved as {
    kind: 'literal' | 'authFile';
    value: string;
    cacheKey?: string;
  };
}

export function planRouteCodexConfigLoaderPathsNativeSync(input: {
  explicitPath?: string;
  routecodexProviderDir?: string;
  rccProviderDir?: string;
}): {
  explicitPath?: string;
  providerRootDir?: string;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.planRouteCodexConfigLoaderPathsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planRouteCodexConfigLoaderPathsJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    explicitPath: input.explicitPath,
    routecodexProviderDir: input.routecodexProviderDir,
    rccProviderDir: input.rccProviderDir
  }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (typeof plan.explicitPath !== 'undefined' && typeof plan.explicitPath !== 'string') {
    throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid explicitPath');
  }
  if (typeof plan.providerRootDir !== 'undefined' && typeof plan.providerRootDir !== 'string') {
    throw new Error('[llmswitch-bridge] RouteCodex config loader path planner returned invalid providerRootDir');
  }
  return plan as {
    explicitPath?: string;
    providerRootDir?: string;
  };
}

export function planProviderConfigRootNativeSync(rootDir?: string): {
  rootDir?: string;
} {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.planProviderConfigRootJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planProviderConfigRootJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({ rootDir }))) as unknown;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-bridge] Provider config root planner returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (typeof plan.rootDir !== 'undefined' && typeof plan.rootDir !== 'string') {
    throw new Error('[llmswitch-bridge] Provider config root planner returned invalid rootDir');
  }
  return plan as { rootDir?: string };
}

function safeBridgeCwd(): string | undefined {
  try {
    const cwd = process.cwd();
    return typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function parseDecodedConfigTextOutput(output: unknown, kind: 'user' | 'provider'): {
  format: 'toml';
  parsed: AnyRecord;
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config text decoder returned invalid payload`);
  }
  const record = output as AnyRecord;
  if (record.format !== 'toml' ||
      !record.parsed ||
      typeof record.parsed !== 'object' ||
      Array.isArray(record.parsed)) {
    throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config text decoder returned invalid shape`);
  }
  return {
    format: 'toml',
    parsed: record.parsed as AnyRecord,
  };
}

export function resolveRouteCodexConfigPathNativeSync(options: {
  preferredPath?: string;
  configName?: string;
  allowDirectoryScan?: boolean;
  baseDir?: string;
} = {}): string {
  const binding = loadNativeBindingForConfigCodec();
  const fn = binding.resolveRouteCodexConfigPathJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRouteCodexConfigPathJson not available');
  }
  const output = parseNativeJsonResult(fn(JSON.stringify({
    preferredPath: options.preferredPath,
    configName: options.configName,
    allowDirectoryScan: options.allowDirectoryScan ?? true,
    baseDir: options.baseDir,
    cwd: safeBridgeCwd(),
    homeDir: process.env.HOME,
    execPath: process.execPath,
    routecodexConfigPath: process.env.ROUTECODEX_CONFIG_PATH,
    routecodexConfig: process.env.ROUTECODEX_CONFIG,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  }))) as unknown;
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-bridge] RouteCodex config path resolver returned invalid path');
  }
  return output;
}

function loadNativeBindingForConfigCodec(): AnyRecord {
  const coreDir = resolveCorePackageDir('ts');
  const nativePath = path.join(coreDir, 'dist', 'native', 'router_hotpath_napi.node');
  return nodeRequire(nativePath) as AnyRecord;
}

function parseNativeTomlRecord(raw: string): AnyRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] RouteCodex TOML parser returned invalid payload');
  }
  return parsed as AnyRecord;
}

function parseDetectedConfigFormatOutput(output: unknown, kind: string): 'toml' {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config format detector returned invalid payload`);
  }
  const format = (output as AnyRecord).format;
  if (format !== 'toml') {
    throw new Error(`[llmswitch-bridge] RouteCodex ${kind} config format detector returned invalid format`);
  }
  return 'toml';
}

// ---------------------------------------------------------------------------
// Native handle-mode HubPipeline entry points.
// Server runtime stores opaque handles and calls the native engine directly.
// ---------------------------------------------------------------------------

export function createHubPipelineNative(config: AnyRecord): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] createHubPipelineNative requires a JSON object config');
  }
  const createHubPipelineEngineJson = requireNativeHubPipelineFn<(inputJson: string) => string>(
    'createHubPipelineEngineJson'
  );
  const result = createHubPipelineEngineJson(JSON.stringify(config));
  const parsed = parseHubPipelineNativeJsonResult(result, 'createHubPipelineNative');
  const handle = parsed.handle;
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] createHubPipelineNative returned invalid handle');
  }
  return handle;
}

export function executeHubPipelineNative(handle: string, request: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] executeHubPipelineNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] executeHubPipelineNative requires JSON object request');
  }
  const hubPipelineExecuteJson = requireNativeHubPipelineFn<(handle: string, requestJson: string) => string>(
    'hubPipelineExecuteJson'
  );
  const raw = hubPipelineExecuteJson(handle, JSON.stringify(request));
  return parseHubPipelineNativeJsonResult(raw, 'executeHubPipelineNative');
}

export function updateHubPipelineVirtualRouterConfigNative(handle: string, config: AnyRecord): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires non-empty handle');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-bridge] updateHubPipelineVirtualRouterConfigNative requires JSON object config');
  }
  const updateHubPipelineVirtualRouterConfigJson = requireNativeHubPipelineFn<
    (handle: string, configJson: string) => void
  >('updateHubPipelineVirtualRouterConfigJson');
  updateHubPipelineVirtualRouterConfigJson(handle, JSON.stringify(config));
}

export function updateHubPipelineEngineDepsNative(handle: string, deps: AnyRecord): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires non-empty handle');
  }
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new Error('[llmswitch-bridge] updateHubPipelineEngineDepsNative requires JSON object deps');
  }
  const updateHubPipelineEngineDepsJson = requireNativeHubPipelineFn<
    (handle: string, depsJson: string) => void
  >('updateHubPipelineEngineDepsJson');
  updateHubPipelineEngineDepsJson(handle, JSON.stringify(deps));
}

export function routeHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object request');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('[llmswitch-bridge] routeHubPipelineVirtualRouterNative requires JSON object metadata');
  }
  const hubPipelineVirtualRouterRouteJson = requireNativeHubPipelineFn<
    (handle: string, requestJson: string, metadataJson: string) => string
  >('hubPipelineVirtualRouterRouteJson');
  const hostEffectsModule = getVirtualRouterRouteHostEffectsModule();
  const createHostEffects = hostEffectsModule.createVirtualRouterRouteHostEffects;
  const injectRuntimeMetadata = hostEffectsModule.injectVirtualRouterRuntimeMetadata;
  if (typeof createHostEffects !== 'function') {
    throw new Error('[llmswitch-bridge] createVirtualRouterRouteHostEffects not available');
  }
  if (typeof injectRuntimeMetadata !== 'function') {
    throw new Error('[llmswitch-bridge] injectVirtualRouterRuntimeMetadata not available');
  }
  const routeHostEffects = createHostEffects({ request, metadata });
  const nativeMetadata = injectRuntimeMetadata(metadata);
  const raw = hubPipelineVirtualRouterRouteJson(handle, JSON.stringify(request), JSON.stringify(nativeMetadata));
  try {
    const parsed = JSON.parse(raw) as AnyRecord;
    routeHostEffects.finalize(
      parsed as { target: AnyRecord; decision: AnyRecord },
      () => null
    );
    return parsed;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] routeHubPipelineVirtualRouterNative returned invalid payload: ${String(error)}`);
  }
}

export function diagnoseHubPipelineVirtualRouterNative(handle: string, request: AnyRecord, metadata: AnyRecord): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires non-empty handle');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object request');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative requires JSON object metadata');
  }
  const hubPipelineVirtualRouterDiagnoseRouteJson = requireNativeHubPipelineFn<
    (handle: string, requestJson: string, metadataJson: string) => string
  >('hubPipelineVirtualRouterDiagnoseRouteJson');
  const raw = hubPipelineVirtualRouterDiagnoseRouteJson(handle, JSON.stringify(request), JSON.stringify(metadata));
  try {
    return JSON.parse(raw) as AnyRecord;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] diagnoseHubPipelineVirtualRouterNative returned invalid payload: ${String(error)}`);
  }
}

export function getHubPipelineVirtualRouterStatusNative(handle: string): AnyRecord {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterStatusJson = requireNativeHubPipelineFn<(handle: string) => string>(
    'hubPipelineVirtualRouterStatusJson'
  );
  const raw = hubPipelineVirtualRouterStatusJson(handle);
  try {
    return JSON.parse(raw) as AnyRecord;
  } catch (error) {
    throw new Error(`[llmswitch-bridge] getHubPipelineVirtualRouterStatusNative returned invalid payload: ${String(error)}`);
  }
}

export function markHubPipelineVirtualRouterConcurrencyScopeBusyNative(handle: string, scopeKey: string): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeBusyNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson = requireNativeHubPipelineFn<
    (handle: string, scopeKey: string) => void
  >('hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson');
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson(handle, String(scopeKey ?? ''));
}

export function markHubPipelineVirtualRouterConcurrencyScopeIdleNative(handle: string, scopeKey: string): void {
  if (typeof handle !== 'string' || !handle) {
    throw new Error('[llmswitch-bridge] markHubPipelineVirtualRouterConcurrencyScopeIdleNative requires non-empty handle');
  }
  const hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson = requireNativeHubPipelineFn<
    (handle: string, scopeKey: string) => void
  >('hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson');
  hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson(handle, String(scopeKey ?? ''));
}

export function disposeHubPipelineNative(handle: string): void {
  if (typeof handle !== 'string' || !handle) {
    return;
  }
  const disposeHubPipelineEngineJson = requireNativeHubPipelineFn<(handle: string) => void>(
    'disposeHubPipelineEngineJson'
  );
  disposeHubPipelineEngineJson(handle);
}

export function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  const metaUrl = getImportMetaUrlUnsafe();
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      const __filename = fileURLToPath(metaUrl);
      return path.resolve(path.dirname(__filename), '../../../..');
    } catch {
      // fall through
    }
  }
  return process.cwd();
}
