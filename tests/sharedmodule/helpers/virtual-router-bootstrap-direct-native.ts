import {
  callNativeJson,
  VirtualRouterError,
  VirtualRouterErrorCode
} from './native-router-hotpath-loader.js';

export type ProviderProfile = Record<string, unknown>;
export type ProviderRuntimeProfile = Record<string, unknown>;
export type RouterMetadataInput = Record<string, unknown>;
export type VirtualRouterConfig = Record<string, unknown>;
export type VirtualRouterBootstrapInput = Record<string, unknown>;
export type VirtualRouterBootstrapResult = {
  config: VirtualRouterConfig;
  runtime: Record<string, ProviderRuntimeProfile>;
  targetRuntime?: Record<string, ProviderRuntimeProfile>;
  providers?: Record<string, ProviderProfile>;
  [key: string]: unknown;
};

export {
  VirtualRouterError,
  VirtualRouterErrorCode
};

export function bootstrapVirtualRouterConfig(
  input: VirtualRouterBootstrapInput
): VirtualRouterBootstrapResult {
  return callNativeJson(
    'bootstrapVirtualRouterConfigJson',
    'bootstrapVirtualRouterConfigJson',
    [JSON.stringify(input ?? {})],
    parseVirtualRouterBootstrapResult,
    {
      createEmptyError: () => new VirtualRouterError(
        'Virtual router native config bootstrap returned empty payload',
        VirtualRouterErrorCode.CONFIG_ERROR
      ),
      invalidReason: 'Virtual router native config bootstrap returned invalid payload',
      mapVirtualRouterErrors: true,
      rethrowUnknownErrors: true
    }
  );
}

function parseVirtualRouterBootstrapResult(raw: string): VirtualRouterBootstrapResult | null {
  try {
    return JSON.parse(raw) as VirtualRouterBootstrapResult;
  } catch {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
}
