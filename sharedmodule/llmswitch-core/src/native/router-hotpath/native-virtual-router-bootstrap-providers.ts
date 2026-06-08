import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderProfile,
  type ProviderRuntimeProfile
} from './virtual-router-contracts.js';
import { parseVirtualRouterNativeError } from './native-router-hotpath-loader.js';
import { isNativeDisabledByEnv, makeNativeRequiredError } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';

type ModelIndexEntry = {
  declared: boolean;
  models: string[];
};

type NativeProvidersBootstrapPayload = {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Record<string, string[]>;
  modelIndex: Record<string, ModelIndexEntry>;
};

type NativeProviderProfilesBootstrapPayload = {
  profiles: Record<string, ProviderProfile>;
  targetRuntime: Record<string, ProviderRuntimeProfile>;
};

function requireNativeFunction(exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(exportName, 'native disabled');
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(exportName);
  }
  return fn as (...args: string[]) => unknown;
}

function parseJsonPayload<T>(raw: unknown): T {
  const returnedVirtualRouterError = parseVirtualRouterNativeError(raw);
  if (returnedVirtualRouterError) {
    throw returnedVirtualRouterError;
  }
  if (typeof raw !== 'string' || !raw) {
    throw new VirtualRouterError(
      'Virtual router native bootstrap returned empty payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new VirtualRouterError(
      'Virtual router native bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
}

export function bootstrapProvidersWithNative(input: {
  providersSource: Record<string, unknown>;
}): {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, ModelIndexEntry>;
  source: 'native';
} {
  const fn = requireNativeFunction('bootstrapVirtualRouterProvidersJson');
  let raw: unknown;
  try {
    raw = fn(JSON.stringify(input.providersSource ?? {}));
  } catch (error) {
    const virtualRouterError = parseVirtualRouterNativeError(error);
    if (virtualRouterError) throw virtualRouterError;
    throw error;
  }
  const parsed = parseJsonPayload<NativeProvidersBootstrapPayload>(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.runtimeEntries || !parsed.aliasIndex || !parsed.modelIndex) {
    throw new VirtualRouterError(
      'Virtual router native providers bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  return {
    runtimeEntries: parsed.runtimeEntries,
    aliasIndex: new Map(Object.entries(parsed.aliasIndex)),
    modelIndex: new Map(Object.entries(parsed.modelIndex)),
    source: 'native'
  };
}

export function bootstrapProviderProfilesWithNative(input: {
  routedTargetKeys: Iterable<string>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, ModelIndexEntry>;
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
}): {
  profiles: Record<string, ProviderProfile>;
  targetRuntime: Record<string, ProviderRuntimeProfile>;
  source: 'native';
} {
  const fn = requireNativeFunction('bootstrapVirtualRouterProviderProfilesJson');
  const routedTargetKeys = Array.from(input.routedTargetKeys ?? []);
  const aliasIndex = Object.fromEntries(input.aliasIndex.entries());
  const modelIndex = Object.fromEntries(input.modelIndex.entries());
  let raw: unknown;
  try {
    raw = fn(
      JSON.stringify(routedTargetKeys),
      JSON.stringify(aliasIndex),
      JSON.stringify(modelIndex),
      JSON.stringify(input.runtimeEntries ?? {})
    );
  } catch (error) {
    const virtualRouterError = parseVirtualRouterNativeError(error);
    if (virtualRouterError) throw virtualRouterError;
    throw error;
  }
  const parsed = parseJsonPayload<NativeProviderProfilesBootstrapPayload>(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.profiles || !parsed.targetRuntime) {
    throw new VirtualRouterError(
      'Virtual router native provider profiles bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  return {
    profiles: parsed.profiles,
    targetRuntime: parsed.targetRuntime,
    source: 'native'
  };
}
