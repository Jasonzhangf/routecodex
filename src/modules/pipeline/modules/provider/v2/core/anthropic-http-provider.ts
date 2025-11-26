/**
 * Anthropic HTTP Provider (V2)
 *
 * 平行版本的标准 HTTP Provider，仅代表 Anthropic Messages 协议族。
 * - 只负责 HTTP 通信与认证
 * - 不做任何厂商兼容 patch
 * - providerType 始终为 'anthropic'
 */

import { OpenAIStandard } from './openai-standard.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';

export class AnthropicHttpProvider extends OpenAIStandard {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'anthropic'
      }
    };
    super(cfg, dependencies);
  }
}
