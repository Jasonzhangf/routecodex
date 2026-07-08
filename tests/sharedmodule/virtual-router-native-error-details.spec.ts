import { describe, expect, it } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';

const originalFactory = (VirtualRouterEngine as unknown as { prototype: { nativeProxy: unknown } }).prototype;

describe('VirtualRouterEngine native error normalization', () => {
  it('preserves details when native route throws VirtualRouterError-like object', () => {
    const engine = new VirtualRouterEngine();
    const providerDetails = {
      candidateProviderKeys: ['sdfv.key1.gpt-5.4'],
      unavailableProviders: [
        { providerKey: 'sdfv.key1.gpt-5.4', reasons: [{ type: 'health_cooldown', waitMs: 1800000 }] }
      ]
    };
    (engine as unknown as { nativeProxy: { route: (req: string, meta: string) => string } }).nativeProxy = {
      route: () => {
        throw {
          code: 'PROVIDER_NOT_AVAILABLE',
          message: 'No available providers after applying routing instructions',
          details: providerDetails
        };
      }
    } as unknown as never;

    expect(() => {
      engine.route({ messages: [] } as never, { requestId: 'req_test' } as never);
    }).toThrow(expect.objectContaining({
      code: 'PROVIDER_NOT_AVAILABLE',
      details: providerDetails
    }));
  });
});
