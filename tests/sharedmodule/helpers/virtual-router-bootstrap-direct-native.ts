import type {
  ProviderProfile,
  ProviderRuntimeProfile,
  RouterMetadataInput,
  VirtualRouterBootstrapInput,
  VirtualRouterBootstrapResult,
  VirtualRouterConfig
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';
import {
  callNativeJson,
  VirtualRouterError,
  VirtualRouterErrorCode
} from './native-router-hotpath-loader.js';

export type {
  ProviderProfile,
  ProviderRuntimeProfile,
  RouterMetadataInput,
  VirtualRouterBootstrapInput,
  VirtualRouterBootstrapResult,
  VirtualRouterConfig
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
