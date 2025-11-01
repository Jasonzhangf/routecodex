/**
 * 简化的LM Studio Provider - 只做HTTP请求，不做任何转换
 */

import type { ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import { BaseHttpProvider } from './shared/base-http-provider.js';

/**
 * 简化的LM Studio Provider - 标准HTTP服务器
 */
export class LMStudioProviderSimple extends BaseHttpProvider {
  readonly type = 'lmstudio-http';
  readonly providerType = 'lmstudio';

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
  }

  protected getDefaultBaseUrl(): string {
    const providerConfig = this.config.config as any;
    return providerConfig.baseUrl || 'http://localhost:1234';
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.getDefaultBaseUrl();
    return path ? `${baseUrl}${path}` : `${baseUrl}/v1/chat/completions`;
  }
}