import {
  type ProviderRuntimeProfile
} from './virtual-router-contracts.js';
import { VirtualRouterError, VirtualRouterErrorCode } from './native-router-hotpath-loader.js';
import { callNativeJson } from './native-router-hotpath.js';

export type {
  ProviderRuntimeProfile
} from './virtual-router-contracts.js';

type ModelIndexEntry = {
  declared: boolean;
  models: string[];
};

type NativeProvidersBootstrapPayload = {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Record<string, string[]>;
  modelIndex: Record<string, ModelIndexEntry>;
};

function parseNativeProvidersBootstrapPayload(raw: string): NativeProvidersBootstrapPayload | null {
  try {
    return JSON.parse(raw) as NativeProvidersBootstrapPayload;
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
  const parsed = callNativeJson(
    'bootstrapVirtualRouterProvidersJson',
    'bootstrapVirtualRouterProvidersJson',
    [JSON.stringify(input.providersSource ?? {})],
    parseNativeProvidersBootstrapPayload,
    {
      createEmptyError: () => new VirtualRouterError(
        'Virtual router native bootstrap returned empty payload',
        VirtualRouterErrorCode.CONFIG_ERROR
      ),
      invalidReason: 'Virtual router native bootstrap returned invalid payload',
      mapVirtualRouterErrors: true,
      rethrowUnknownErrors: true
    }
  );
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
