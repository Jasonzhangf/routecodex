import {
  makeNativeRequiredError,
  parseNativeJsonObjectOrFail,
  parseNativeJsonValueOrFail,
  readNativeFunction,
  safeStringify,
  stringifyNativePayloadForError
} from './native-router-hotpath-loader.js';

type AnyRecord = Record<string, unknown>;

function invokeConfigCapability(capability: string, input: AnyRecord): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw makeNativeRequiredError(capability);
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    throw makeNativeRequiredError(capability, 'json stringify failed');
  }
  const raw = fn(inputJson);
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  const reason = stringifyNativePayloadForError(raw);
  if (reason) {
    throw new Error(reason);
  }
  throw makeNativeRequiredError(capability, 'empty result');
}

function callConfigObject(capability: string, input: AnyRecord): AnyRecord {
  return parseNativeJsonObjectOrFail<AnyRecord>(
    capability,
    invokeConfigCapability(capability, input)
  );
}

function callConfigValue<T>(capability: string, input: AnyRecord): T {
  return parseNativeJsonValueOrFail<T>(
    capability,
    invokeConfigCapability(capability, input)
  );
}

function parseOptionalStringObject(output: unknown, capability: string, keys: string[]): AnyRecord {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[config-direct-native] ${capability} returned invalid payload`);
  }
  const record = output as AnyRecord;
  for (const key of keys) {
    if (typeof record[key] !== 'undefined' && typeof record[key] !== 'string') {
      throw new Error(`[config-direct-native] ${capability} returned invalid ${key}`);
    }
  }
  return record;
}

function parseDecodedConfigTextOutput(output: unknown, label: string): {
  format: 'toml';
  parsed: AnyRecord;
} {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    (output as AnyRecord).format !== 'toml' ||
    !(output as AnyRecord).parsed ||
    typeof (output as AnyRecord).parsed !== 'object' ||
    Array.isArray((output as AnyRecord).parsed)
  ) {
    throw new Error(`[config-direct-native] ${label} config decoder returned invalid payload`);
  }
  return output as { format: 'toml'; parsed: AnyRecord };
}

function parseDetectedConfigFormatOutput(output: unknown, label: string): 'toml' {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    (output as AnyRecord).format !== 'toml'
  ) {
    throw new Error(`[config-direct-native] ${label} config format detector returned invalid payload`);
  }
  return 'toml';
}

function parsePersistedConfigFileOutput(output: unknown, label: string): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`[config-direct-native] ${label} writer returned invalid payload`);
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
    throw new Error(`[config-direct-native] ${label} writer returned invalid shape`);
  }
  return persisted as {
    path: string;
    format: 'toml';
    raw: string;
    parsed: AnyRecord;
  };
}

function parseRuntimeManifestOutput(output: unknown): AnyRecord {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[config-direct-native] runtime config compiler returned invalid payload');
  }
  const manifest = output as AnyRecord;
  if (
    manifest.manifestVersion !== 'routecodex.runtime-config.v1' ||
    !manifest.virtualRouterBootstrapInput ||
    typeof manifest.virtualRouterBootstrapInput !== 'object' ||
    Array.isArray(manifest.virtualRouterBootstrapInput) ||
    !manifest.pipelineRuntimeConfig ||
    typeof manifest.pipelineRuntimeConfig !== 'object' ||
    Array.isArray(manifest.pipelineRuntimeConfig)
  ) {
    throw new Error('[config-direct-native] runtime config compiler returned invalid manifest');
  }
  return manifest;
}

export function decodeRouteCodexUserConfigTextWithNative(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  return parseDecodedConfigTextOutput(
    callConfigObject('decodeRouteCodexUserConfigTextJson', {
      raw: String(input.raw ?? ''),
      ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
    }),
    'user'
  );
}

export function decodeRouteCodexProviderConfigTextWithNative(input: {
  raw: string;
  configPath?: string;
}): {
  format: 'toml';
  parsed: AnyRecord;
} {
  return parseDecodedConfigTextOutput(
    callConfigObject('decodeRouteCodexProviderConfigTextJson', {
      raw: String(input.raw ?? ''),
      ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {})
    }),
    'provider'
  );
}

export function detectRouteCodexUserConfigFormatWithNative(configPath: string): 'toml' {
  return parseDetectedConfigFormatOutput(
    callConfigObject('detectRouteCodexUserConfigFormatJson', {
      configPath: String(configPath ?? '')
    }),
    'user'
  );
}

export function detectRouteCodexProviderConfigFormatWithNative(configPath: string): 'toml' {
  return parseDetectedConfigFormatOutput(
    callConfigObject('detectRouteCodexProviderConfigFormatJson', {
      configPath: String(configPath ?? '')
    }),
    'provider'
  );
}

export function resolveRccSnapshotsDirWithNative(homeDir?: string): string {
  const output = callConfigObject('resolveRccSnapshotsDirJson', {
    homeDir,
    rccSnapshotDir: process.env.RCC_SNAPSHOT_DIR,
    routecodexSnapshotDir: process.env.ROUTECODEX_SNAPSHOT_DIR,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  const snapshotsDir = output.snapshotsDir;
  if (typeof snapshotsDir !== 'string' || !snapshotsDir.trim()) {
    throw new Error('[config-direct-native] snapshot dir resolver returned invalid path');
  }
  return snapshotsDir;
}

export function resolveRouteCodexConfigPathWithNative(options: {
  preferredPath?: string;
  configName?: string;
  allowDirectoryScan?: boolean;
  baseDir?: string;
} = {}): string {
  return callConfigValue<string>('resolveRouteCodexConfigPathJson', {
    preferredPath: options.preferredPath,
    configName: options.configName,
    allowDirectoryScan: options.allowDirectoryScan ?? true,
    baseDir: options.baseDir,
    cwd: process.cwd(),
    homeDir: process.env.HOME,
    execPath: process.execPath,
    routecodexConfigPath: process.env.ROUTECODEX_CONFIG_PATH,
    routecodexConfig: process.env.ROUTECODEX_CONFIG,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
}

export function planAuthFileResolutionWithNative(input: {
  keyId: string;
  authDir?: string;
  homeDir?: string;
}): {
  kind: 'literal' | 'authFile';
  value?: string;
  filePath?: string;
  cacheKey?: string;
} {
  const output = callConfigObject('planAuthFileResolutionJson', {
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  if (output.kind !== 'literal' && output.kind !== 'authFile') {
    throw new Error('[config-direct-native] auth file planner returned invalid kind');
  }
  return output as {
    kind: 'literal' | 'authFile';
    value?: string;
    filePath?: string;
    cacheKey?: string;
  };
}

export function resolveAuthFileKeyWithNative(input: {
  keyId: string;
  authDir?: string;
  homeDir?: string;
}): {
  kind: 'literal' | 'authFile';
  value: string;
  cacheKey?: string;
} {
  const output = callConfigObject('resolveAuthFileKeyJson', {
    keyId: String(input.keyId ?? ''),
    authDir: input.authDir,
    homeDir: input.homeDir,
    rccHome: process.env.RCC_HOME,
    routecodexUserDir: process.env.ROUTECODEX_USER_DIR,
    routecodexHome: process.env.ROUTECODEX_HOME
  });
  if ((output.kind !== 'literal' && output.kind !== 'authFile') || typeof output.value !== 'string') {
    throw new Error('[config-direct-native] auth file resolver returned invalid shape');
  }
  return output as {
    kind: 'literal' | 'authFile';
    value: string;
    cacheKey?: string;
  };
}

export function planRouteCodexConfigLoaderPathsWithNative(input: {
  explicitPath?: string;
  routecodexProviderDir?: string;
  rccProviderDir?: string;
}): {
  explicitPath?: string;
  providerRootDir?: string;
} {
  return parseOptionalStringObject(
    callConfigObject('planRouteCodexConfigLoaderPathsJson', {
      explicitPath: input.explicitPath,
      routecodexProviderDir: input.routecodexProviderDir,
      rccProviderDir: input.rccProviderDir
    }),
    'planRouteCodexConfigLoaderPathsJson',
    ['explicitPath', 'providerRootDir']
  ) as {
    explicitPath?: string;
    providerRootDir?: string;
  };
}

export function planProviderConfigRootWithNative(rootDir?: string): {
  rootDir?: string;
} {
  return parseOptionalStringObject(
    callConfigObject('planProviderConfigRootJson', { rootDir }),
    'planProviderConfigRootJson',
    ['rootDir']
  ) as { rootDir?: string };
}

export function compileRouteCodexRuntimeManifestWithNative(input: AnyRecord): AnyRecord {
  return parseRuntimeManifestOutput(callConfigObject('compileRouteCodexRuntimeManifestJson', input ?? {}));
}

export function writeRouteCodexUserConfigFileWithNative(input: {
  configPath: string;
  parsed: AnyRecord;
  format?: 'toml';
}): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  return parsePersistedConfigFileOutput(
    callConfigObject('writeRouteCodexUserConfigFileJson', {
      configPath: input.configPath,
      parsed: input.parsed ?? {},
      format: input.format
    }),
    'user config'
  );
}

export function writeRouteCodexProviderConfigFileWithNative(input: {
  configPath: string;
  parsed: AnyRecord;
  format?: 'toml';
}): {
  path: string;
  format: 'toml';
  raw: string;
  parsed: AnyRecord;
} {
  return parsePersistedConfigFileOutput(
    callConfigObject('writeRouteCodexProviderConfigFileJson', {
      configPath: input.configPath,
      parsed: input.parsed ?? {},
      format: input.format
    }),
    'provider config'
  );
}

export function updateRouteCodexUserConfigStringScalarWithNative(input: {
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
  return parsePersistedConfigFileOutput(
    callConfigObject('updateRouteCodexUserConfigStringScalarJson', {
      configPath: input.configPath,
      tablePath: input.tablePath,
      key: input.key,
      value: input.value
    }),
    'user config scalar update'
  );
}
