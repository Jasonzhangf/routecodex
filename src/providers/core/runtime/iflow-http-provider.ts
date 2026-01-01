/**
 * iFlow HTTP Provider (V2)
 *
 * iFlow 专用的 HTTP Provider，支持 OAuth 认证
 * - providerType 始终为 'iflow'
 * - 支持 OAuth 认证流程
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';

interface MetadataContainer {
  metadata?: Record<string, unknown>;
}

export class iFlowHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'iflow'
      }
    };
    super(cfg, dependencies, 'iflow-http-provider');
  }

  private isWebSearchRequest(request: UnknownObject): boolean {
    const metadata = (request as MetadataContainer).metadata;
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }
    const flag = (metadata as { iflowWebSearch?: unknown }).iflowWebSearch;
    return flag === true;
  }

  protected override resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string {
    if (this.isWebSearchRequest(request)) {
      const metadata = (request as MetadataContainer).metadata;
      const endpoint =
        metadata && typeof (metadata as { entryEndpoint?: unknown }).entryEndpoint === 'string'
          ? ((metadata as { entryEndpoint: string }).entryEndpoint || '').trim()
          : '';
      return endpoint || '/chat/retrieve';
    }
    return super.resolveRequestEndpoint(request, defaultEndpoint);
  }

  protected override buildHttpRequestBody(request: UnknownObject): UnknownObject {
    if (this.isWebSearchRequest(request)) {
      const data = (request as { data?: unknown }).data;
      if (data && typeof data === 'object') {
        return data as UnknownObject;
      }
      return {};
    }
    return super.buildHttpRequestBody(request);
  }
}
