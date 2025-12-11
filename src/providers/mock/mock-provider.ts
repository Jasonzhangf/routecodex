import type { ModuleDependencies } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { OpenAIStandardConfig } from '../core/api/provider-config.js';
import type { UnknownObject } from '../../types/common-types.js';
import type { ServiceProfile } from '../core/api/provider-types.js';
import { BaseProvider } from '../core/runtime/base-provider.js';
import { extractProviderRuntimeMetadata } from '../core/runtime/provider-runtime-metadata.js';
import { MockProviderRuntime } from './mock-provider-runtime.js';

export class MockProvider extends BaseProvider {
  readonly type = 'mock-provider';
  private runtime: MockProviderRuntime;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
    const providerId = (config.config as any).providerId || 'unknown';
    const model = (config.config as any).modelId || 'unknown';
    this.runtime = new MockProviderRuntime({ providerId, model });
  }

  protected getServiceProfile(): ServiceProfile {
    return {
      providerType: 'mock' as any,
      defaultBaseUrl: 'mock://',
      defaultEndpoint: '/mock',
      defaultModel: 'mock-model',
      requiredAuth: { type: 'none' },
      optionalAuth: []
    } as any;
  }

  protected createAuthProvider() {
    return {
      initialize: async () => {},
      getAuthHeaders: async () => ({}),
      refreshToken: async () => ({})
    } as any;
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    return request;
  }

  protected async postprocessResponse(response: UnknownObject): Promise<UnknownObject> {
    return response as UnknownObject;
  }

  async initialize(): Promise<void> {
    await this.runtime.initialize();
    return super.initialize();
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const metadata = extractProviderRuntimeMetadata(request);
    if (metadata?.requestId && request && typeof request === 'object') {
      (request as Record<string, unknown>).requestId = metadata.requestId;
    }
    return this.runtime.process(request);
  }
}
