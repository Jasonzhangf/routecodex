/**
 * Gemini HTTP Provider (V2)
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { GeminiProtocolClient } from '../../../client/gemini/gemini-protocol-client.js';

export class GeminiHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'gemini' as ProviderType
      }
    };
    super(cfg, dependencies, 'gemini-http-provider', new GeminiProtocolClient());
  }

  protected override async postprocessResponse(response: unknown, _context: ProviderContext): Promise<UnknownObject> {
    if (response && typeof response === 'object') {
      return response as UnknownObject;
    }
    return { data: response } as UnknownObject;
  }
}

export default GeminiHttpProvider;
