/**
 * iFlow HTTP Provider (V2)
 *
 * iFlow 专用的 HTTP Provider，支持 OAuth 认证
 * - providerType 始终为 'iflow'
 * - 支持 OAuth 认证流程
 */

import { OpenAIStandard } from './openai-standard.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';

export class iFlowHttpProvider extends OpenAIStandard {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'iflow'
      }
    };
    super(cfg, dependencies);
  }
}
