/**
 * Responses HTTP Provider (V2)
 *
 * 平行版本的标准 HTTP Provider，仅代表 Responses 协议族。
 * - 只负责 HTTP 通信与认证（包括上游 SSE 行为）
 * - 不做任何厂商兼容 patch
 * - providerType 始终为 'responses'
 *
 * 说明：
 * - 这里直接复用 ResponsesProvider 的能力（SSE 直通等），仅在构造时固定 providerType。
 */

import { ResponsesProvider } from './responses-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';

export class ResponsesHttpProvider extends ResponsesProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'responses'
      }
    };
    super(cfg, dependencies);
  }
}
