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
}
