/**
 * Config Integrations Bridge
 *
 * Thin host shell for Rust-owned RouteCodex config/path/profile codecs.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';
import {
  callNativeJsonCapability,
  parseNativeJsonResult,
  requireNativeFunction,
  stringifyNativeJsonArg,
} from './native-json-invoker.js';

type AnyRecord = Record<string, unknown>;

const CONFIG_BRIDGE_LABEL = 'llmswitch-config-bridge';

function callConfigJson<T = unknown>(capability: string, input: unknown): T {
  return callNativeJsonCapability<T>(
    getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>,
    capability,
    [input],
    { label: CONFIG_BRIDGE_LABEL },
  );
}

function encodeConfigJsonArg(capability: string, input: unknown): string {
  const encoded = stringifyNativeJsonArg(capability, input, { label: CONFIG_BRIDGE_LABEL });
  if (encoded === null) {
    throw new Error(`[${CONFIG_BRIDGE_LABEL}] ${capability} JSON stringify returned null`);
  }
  return encoded;
}

function callConfigNativeFunction(capability: string, ...args: unknown[]): unknown {
  return requireNativeFunction(
    getRouterHotpathJsonBindingSync as unknown as () => Record<string, unknown>,
    capability,
    { label: CONFIG_BRIDGE_LABEL },
  )(...args);
}

function safeBridgeCwd(): string | undefined {
  try {
    const cwd = process.cwd();
    return typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function parseNativeTomlRecord(raw: string, capability = 'parseRouteCodexTomlRecordJson'): AnyRecord {
  const parsed = parseNativeJsonResult(capability, raw, { label: CONFIG_BRIDGE_LABEL });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex TOML parser returned invalid payload');
  }
  return parsed as AnyRecord;
}

function parseDetectedConfigFormatOutput(output: unknown, kind: string): 'toml' {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-config-bridge] RouteCodex ${kind} config format detector returned invalid payload`);
  }
  const format = (output as AnyRecord).format;
  if (format !== 'toml') {
    throw new Error(`[llmswitch-config-bridge] RouteCodex ${kind} config format detector returned invalid format`);
  }
  return 'toml';
}

function parseDecodedConfigTextOutput(output: unknown, kind: 'user' | 'provider'): {
  format: 'toml';
  parsed: AnyRecord;
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-config-bridge] RouteCodex ${kind} config text decoder returned invalid payload`);
  }
  const record = output as AnyRecord;
  if (record.format !== 'toml' ||
      !record.parsed ||
      typeof record.parsed !== 'object' ||
      Array.isArray(record.parsed)) {
    throw new Error(`[llmswitch-config-bridge] RouteCodex ${kind} config text decoder returned invalid shape`);
  }
  return {
    format: 'toml',
    parsed: record.parsed as AnyRecord,
  };
}

function validatePersistedConfigFileOutput(output: unknown, label: string): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[llmswitch-config-bridge] ${label} writer returned invalid payload`);
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
    throw new Error(`[llmswitch-config-bridge] ${label} writer returned invalid shape`);
  }
  return persisted as {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
  };
}

export async function compileRouteCodexRuntimeManifest(input: AnyRecord): Promise<AnyRecord> {
  return compileRouteCodexRuntimeManifestSync(input);
}

export function compileRouteCodexRuntimeManifestSync(input: AnyRecord): AnyRecord {
  const output = callConfigJson('compileRouteCodexRuntimeManifestJson', input ?? {});
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex runtime config compiler returned invalid payload');
  }
  const manifest = output as AnyRecord;
  if (manifest.manifestVersion !== 'routecodex.runtime-config.v1' ||
      !manifest.virtualRouterBootstrapInput ||
      typeof manifest.virtualRouterBootstrapInput !== 'object' ||
      Array.isArray(manifest.virtualRouterBootstrapInput) ||
      !manifest.pipelineRuntimeConfig ||
      typeof manifest.pipelineRuntimeConfig !== 'object' ||
      Array.isArray(manifest.pipelineRuntimeConfig)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex runtime config compiler returned invalid manifest');
  }
  return manifest;
}

export function collectRouteCodexV2ConfigSourceErrorsSync(userConfig: AnyRecord): string[] {
  const output = callConfigJson('collectRouteCodexV2ConfigSourceErrorsJson', {
    userConfig: userConfig ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex config source validator returned invalid payload');
  }
  const errors = (output as AnyRecord).errors;
  if (!Array.isArray(errors) || !errors.every((item) => typeof item === 'string')) {
    throw new Error('[llmswitch-config-bridge] RouteCodex config source validator returned invalid errors');
  }
  return errors;
}

export function normalizeRouteCodexV2RuntimeSourceSync(userConfig: AnyRecord): AnyRecord {
  const output = callConfigJson('normalizeRouteCodexV2RuntimeSourceJson', {
    userConfig: userConfig ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex runtime source normalizer returned invalid payload');
  }
  const normalized = (output as AnyRecord).userConfig;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex runtime source normalizer returned invalid userConfig');
  }
  return normalized as AnyRecord;
}

export function resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig: AnyRecord): string | undefined {
  const output = callConfigJson('resolvePrimaryRouteCodexRoutingPolicyGroupJson', {
    userConfig: userConfig ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex routingPolicyGroup resolver returned invalid payload');
  }
  const group = (output as AnyRecord).routingPolicyGroup;
  if (group === null || typeof group === 'undefined') {
    return undefined;
  }
  if (typeof group !== 'string') {
    throw new Error('[llmswitch-config-bridge] RouteCodex routingPolicyGroup resolver returned invalid group');
  }
  return group;
}

export function extractRouteCodexMaterializedProviderConfigsSync(userConfig: AnyRecord): AnyRecord | null {
  const output = callConfigJson('extractRouteCodexMaterializedProviderConfigsJson', {
    userConfig: userConfig ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex materialized provider extractor returned invalid payload');
  }
  const providerConfigs = (output as AnyRecord).providerConfigs;
  if (providerConfigs === null || typeof providerConfigs === 'undefined') {
    return null;
  }
  if (!providerConfigs || typeof providerConfigs !== 'object' || Array.isArray(providerConfigs)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex materialized provider extractor returned invalid providerConfigs');
  }
  return providerConfigs as AnyRecord;
}

export function materializeRouteCodexUserConfigFromManifestSync(userConfig: AnyRecord, manifest: AnyRecord): AnyRecord {
  const output = callConfigJson('materializeRouteCodexUserConfigFromManifestJson', {
    userConfig: userConfig ?? {},
    manifest: manifest ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex user config materializer returned invalid payload');
  }
  const materialized = (output as AnyRecord).userConfig;
  if (!materialized || typeof materialized !== 'object' || Array.isArray(materialized)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex user config materializer returned invalid userConfig');
  }
  return materialized as AnyRecord;
}

export function buildRouteCodexProviderProfilesSync(userConfig: AnyRecord): AnyRecord {
  const output = callConfigJson('buildRouteCodexProviderProfilesJson', {
    userConfig: userConfig ?? {}
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider profile builder returned invalid payload');
  }
  const providerProfiles = (output as AnyRecord).providerProfiles;
  if (!providerProfiles || typeof providerProfiles !== 'object' || Array.isArray(providerProfiles)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider profile builder returned invalid providerProfiles');
  }
  return providerProfiles as AnyRecord;
}

export function buildRouteCodexForwarderProfilesSync(userConfig: AnyRecord, knownProviderIds: Set<string> | string[]): AnyRecord {
  const providerIds = Array.isArray(knownProviderIds) ? knownProviderIds : Array.from(knownProviderIds ?? []);
  const output = callConfigJson('buildRouteCodexForwarderProfilesJson', {
    userConfig: userConfig ?? {},
    knownProviderIds: providerIds
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex forwarder profile builder returned invalid payload');
  }
  const forwarderProfiles = (output as AnyRecord).forwarderProfiles;
  if (!forwarderProfiles || typeof forwarderProfiles !== 'object' || Array.isArray(forwarderProfiles)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex forwarder profile builder returned invalid forwarderProfiles');
  }
  return forwarderProfiles as AnyRecord;
}

export function parseRouteCodexTomlRecordSync(raw: string): AnyRecord {
  return parseNativeTomlRecord(String(callConfigNativeFunction(
    'parseRouteCodexTomlRecordJson',
    String(raw ?? ''),
  )));
}

export function serializeRouteCodexTomlRecordSync(record: AnyRecord): string {
  return String(callConfigNativeFunction(
    'serializeRouteCodexTomlRecordJson',
    encodeConfigJsonArg('serializeRouteCodexTomlRecordJson', record ?? {}),
  ));
}

export function updateRouteCodexTomlStringScalarInTableSync(input: {
  raw: string;
  tablePath: string[];
  key: string;
  value: string;
}): string {
  return String(callConfigNativeFunction(
    'updateRouteCodexTomlStringScalarInTableJson',
    encodeConfigJsonArg('updateRouteCodexTomlStringScalarInTableJson', {
      raw: String(input.raw ?? ''),
      tablePath: Array.isArray(input.tablePath) ? input.tablePath.map(String) : [],
      key: String(input.key ?? ''),
      value: String(input.value ?? '')
    }),
  ));
}

export function decodeRouteCodexUserConfigTextSync(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  const output = callConfigJson('decodeRouteCodexUserConfigTextJson', {
    raw: String(input.raw ?? ''),
    ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
  });
  return parseDecodedConfigTextOutput(output, 'user');
}

export function decodeRouteCodexProviderConfigTextSync(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  const output = callConfigJson('decodeRouteCodexProviderConfigTextJson', {
    raw: String(input.raw ?? ''),
    ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
  });
  return parseDecodedConfigTextOutput(output, 'provider');
}

export function detectRouteCodexUserConfigFormatSync(configPath: string): 'toml' {
  const output = callConfigJson('detectRouteCodexUserConfigFormatJson', {
    configPath: String(configPath ?? '')
  });
  return parseDetectedConfigFormatOutput(output, 'user');
}

export function detectRouteCodexProviderConfigFormatSync(configPath: string): 'toml' {
  const output = callConfigJson('detectRouteCodexProviderConfigFormatJson', {
    configPath: String(configPath ?? '')
  });
  return parseDetectedConfigFormatOutput(output, 'provider');
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
  return validatePersistedConfigFileOutput(callConfigJson('writeRouteCodexUserConfigFileJson', {
    configPath: input.configPath,
    parsed: input.parsed ?? {},
    format: input.format
  }), 'User config');
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
  return validatePersistedConfigFileOutput(callConfigJson('writeRouteCodexProviderConfigFileJson', {
    configPath: input.configPath,
    parsed: input.parsed ?? {},
    format: input.format
  }), 'Provider config');
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
  return validatePersistedConfigFileOutput(callConfigJson('updateRouteCodexUserConfigStringScalarJson', {
    configPath: input.configPath,
    tablePath: input.tablePath,
    key: input.key,
    value: input.value
  }), 'User config scalar update');
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
  const output = callConfigJson('loadRouteCodexConfigJson', {
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
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex config loader returned invalid payload');
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
    throw new Error('[llmswitch-config-bridge] RouteCodex config loader returned invalid shape');
  }
  return loaded as {
    configPath: string;
    userConfig: AnyRecord;
    providerProfiles: AnyRecord;
  };
}

export function coerceRouteCodexProviderConfigV2Sync(
  parsed: AnyRecord,
  fallbackProviderId?: string
): AnyRecord | null {
  const output = callConfigJson('coerceRouteCodexProviderConfigV2Json', {
    parsed: parsed ?? {},
    fallbackProviderId: String(fallbackProviderId ?? '')
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config coercer returned invalid payload');
  }
  const config = (output as AnyRecord).config;
  if (config === null) {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config coercer returned invalid config');
  }
  return config as AnyRecord;
}

export function planRouteCodexProviderConfigV2FilesSync(fileNames: string[]): Array<{
  fileName: string;
  isBaseFile: boolean;
}> {
  const output = callConfigJson('planRouteCodexProviderConfigV2FilesJson', { fileNames });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config file planner returned invalid payload');
  }
  const files = (output as AnyRecord).files;
  if (!Array.isArray(files)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config file planner returned invalid files');
  }
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('[llmswitch-config-bridge] RouteCodex provider config file planner returned invalid file entry');
    }
    const record = file as AnyRecord;
    if (typeof record.fileName !== 'string' || typeof record.isBaseFile !== 'boolean') {
      throw new Error('[llmswitch-config-bridge] RouteCodex provider config file planner returned invalid file shape');
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
  const output = callConfigJson('resolveRouteCodexProviderConfigV2IdentityJson', input);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config identity resolver returned invalid payload');
  }
  const record = output as AnyRecord;
  if (typeof record.providerId !== 'string' ||
      !record.provider ||
      typeof record.provider !== 'object' ||
      Array.isArray(record.provider)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config identity resolver returned invalid shape');
  }
  return {
    providerId: record.providerId,
    provider: record.provider as AnyRecord
  };
}

export function loadRouteCodexProviderConfigsV2FromRootSync(rootDir: string): Record<string, AnyRecord> {
  const output = callConfigJson('loadRouteCodexProviderConfigsV2FromRootJson', {
    rootDir: String(rootDir ?? '')
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config root loader returned invalid payload');
  }
  const configs = (output as AnyRecord).configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex provider config root loader returned invalid configs');
  }
  return configs as Record<string, AnyRecord>;
}

export function resolveRccUserDirNativeSync(homeDir?: string): string {
  const output = callConfigJson('resolveRccUserDirJson', {
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME,
    ...(typeof homeDir === 'string' ? { homeDir } : {})
  });
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-config-bridge] RouteCodex user dir resolver returned invalid path');
  }
  return output;
}

export function resolveRccPathNativeSync(segments: string[], homeDir?: string): string {
  const output = callConfigJson('resolveRccPathJson', {
    segments: Array.isArray(segments) ? segments.map(String) : [],
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME,
    ...(typeof homeDir === 'string' ? { homeDir } : {})
  });
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-config-bridge] RouteCodex path resolver returned invalid path');
  }
  return output;
}

export function resolveRccSnapshotsDirNativeSync(homeDir?: string): string {
  const output = callConfigJson('resolveRccSnapshotsDirJson', {
    homeDir,
    rccSnapshotDir: process.env.RCC_SNAPSHOT_DIR,
    routecodexSnapshotDir: process.env.ROUTECODEX_SNAPSHOT_DIR,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex snapshots dir resolver returned invalid payload');
  }
  const snapshotsDir = (output as AnyRecord).snapshotsDir;
  if (typeof snapshotsDir !== 'string' || !snapshotsDir.trim()) {
    throw new Error('[llmswitch-config-bridge] RouteCodex snapshots dir resolver returned invalid path');
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
  const output = callConfigJson('planAuthFileResolutionJson', {
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] AuthFile resolver returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (plan.kind !== 'literal' && plan.kind !== 'authFile') {
    throw new Error('[llmswitch-config-bridge] AuthFile resolver returned invalid kind');
  }
  if (plan.kind === 'literal' && typeof plan.value !== 'string') {
    throw new Error('[llmswitch-config-bridge] AuthFile resolver returned invalid literal value');
  }
  if (plan.kind === 'authFile' &&
      (typeof plan.filePath !== 'string' || typeof plan.cacheKey !== 'string')) {
    throw new Error('[llmswitch-config-bridge] AuthFile resolver returned invalid authFile plan');
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
  const output = callConfigJson('resolveAuthFileKeyJson', {
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] AuthFile key resolver returned invalid payload');
  }
  const resolved = output as AnyRecord;
  if ((resolved.kind !== 'literal' && resolved.kind !== 'authFile') || typeof resolved.value !== 'string') {
    throw new Error('[llmswitch-config-bridge] AuthFile key resolver returned invalid shape');
  }
  if (typeof resolved.cacheKey !== 'undefined' && typeof resolved.cacheKey !== 'string') {
    throw new Error('[llmswitch-config-bridge] AuthFile key resolver returned invalid cache key');
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
  const output = callConfigJson('planRouteCodexConfigLoaderPathsJson', {
    explicitPath: input.explicitPath,
    routecodexProviderDir: input.routecodexProviderDir,
    rccProviderDir: input.rccProviderDir
  });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] RouteCodex config loader path planner returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (typeof plan.explicitPath !== 'undefined' && typeof plan.explicitPath !== 'string') {
    throw new Error('[llmswitch-config-bridge] RouteCodex config loader path planner returned invalid explicitPath');
  }
  if (typeof plan.providerRootDir !== 'undefined' && typeof plan.providerRootDir !== 'string') {
    throw new Error('[llmswitch-config-bridge] RouteCodex config loader path planner returned invalid providerRootDir');
  }
  return plan as {
    explicitPath?: string;
    providerRootDir?: string;
  };
}

export function planProviderConfigRootNativeSync(rootDir?: string): {
  rootDir?: string;
} {
  const output = callConfigJson('planProviderConfigRootJson', { rootDir });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[llmswitch-config-bridge] Provider config root planner returned invalid payload');
  }
  const plan = output as AnyRecord;
  if (typeof plan.rootDir !== 'undefined' && typeof plan.rootDir !== 'string') {
    throw new Error('[llmswitch-config-bridge] Provider config root planner returned invalid rootDir');
  }
  return plan as { rootDir?: string };
}

export function resolveRouteCodexConfigPathNativeSync(options: {
  preferredPath?: string;
  configName?: string;
  allowDirectoryScan?: boolean;
  baseDir?: string;
} = {}): string {
  const output = callConfigJson('resolveRouteCodexConfigPathJson', {
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
  });
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('[llmswitch-config-bridge] RouteCodex config path resolver returned invalid path');
  }
  return output;
}
