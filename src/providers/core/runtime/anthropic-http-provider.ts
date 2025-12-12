/**
 * Anthropic HTTP Provider (V2)
 *
 * 平行版本的标准 HTTP Provider，仅代表 Anthropic Messages 协议族。
 * - 只负责 HTTP 通信与认证
 * - 不做任何厂商兼容 patch
 * - providerType 始终为 'anthropic'
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { AnthropicProtocolClient } from '../../../client/anthropic/anthropic-protocol-client.js';

export class AnthropicHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'anthropic'
      }
    };
    super(cfg, dependencies, 'anthropic-http-provider', new AnthropicProtocolClient());
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const streamFromContext = this.extractStreamFlag(context.metadata);
    if (typeof streamFromContext === 'boolean') {
      return streamFromContext;
    }
    const streamFromRequest = this.extractStreamFlag(request);
    return typeof streamFromRequest === 'boolean' ? streamFromRequest : false;
  }

  protected override prepareSseRequestBody(body: UnknownObject): void {
    if (body && typeof body === 'object') {
      (body as Record<string, unknown>).stream = true;
    }
  }

  private extractStreamFlag(source: UnknownObject | ProviderContext['metadata']): boolean | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const metadata =
      'metadata' in source && typeof (source as { metadata?: unknown }).metadata === 'object'
        ? (source as { metadata?: Record<string, unknown> }).metadata
        : (source as Record<string, unknown>);
    if (!metadata || typeof metadata !== 'object') {
      return undefined;
    }
    const value = (metadata as Record<string, unknown>).stream;
    return typeof value === 'boolean' ? value : undefined;
  }
}
