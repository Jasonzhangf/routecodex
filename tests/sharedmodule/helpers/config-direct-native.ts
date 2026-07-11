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
