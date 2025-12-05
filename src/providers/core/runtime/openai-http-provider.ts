/**
 * OpenAI HTTP Provider (V2)
 *
 * 平行版本的标准 HTTP Provider，仅代表 OpenAI 协议族。
 * - 只负责 HTTP 通信与认证
 * - 不做任何厂商兼容 patch（glm/qwen/lmstudio 等交由 Compatibility 层处理）
 * - 不在内部切换协议族，providerType 始终为 'openai'
 *
 * 说明：
 * - 当前实现直接复用 ChatHttpProvider 的能力，但通过固定 providerType='openai'
 *   将其约束为单一协议族的 HTTP Provider，便于后续平滑迁移。
 */

import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

export class OpenAIHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai'
      }
    };
    super(cfg, dependencies, 'openai-http-provider');
  }
}
