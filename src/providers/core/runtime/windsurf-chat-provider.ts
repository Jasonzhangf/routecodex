/**
 * WindsurfChatProvider
 *
 * WindsurfAPI 的 HTTP Transport Provider。
 * 职责：HTTP 发送（stream/non-stream）到 WindsurfAPI、请求头注入、重试、错误上报。
 * 禁止：工具路由、语义修复、账号池管理。
 */

import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import {
  normalizeWindsurfProviderRuntimeOptions,
  WINDSURF_COMPATIBILITY_PROFILE,
  WINDSURF_DEFAULT_BASE_URL,
  WINDSURF_DEFAULT_COMPLETION_ENDPOINT,
} from '../contracts/windsurf-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';

export class WindsurfChatProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'windsurf',
        baseUrl: (config.config.baseUrl || WINDSURF_DEFAULT_BASE_URL).trim(),
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: (config.config.overrides?.endpoint || WINDSURF_DEFAULT_COMPLETION_ENDPOINT).trim(),
        },
      },
    };
    super(cfg, dependencies, 'windsurf-chat-provider');
  }

  protected override getServiceProfile() {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: WINDSURF_DEFAULT_COMPLETION_ENDPOINT,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      streamingModes: ['sse'],
    };
  }

  public override async checkHealth(): Promise<boolean> {
    const ext = normalizeWindsurfProviderRuntimeOptions(
      this.config.config.extensions as UnknownObject | undefined
    );
    const endpoint = ext.healthCheckEndpoint || '/v1/models';
    const timeout = ext.healthCheckTimeoutMs ?? 5000;
    const url = endpoint.startsWith('http') ? endpoint : `${this.config.config.baseUrl || WINDSURF_DEFAULT_BASE_URL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
    return this.performHealthCheck(url);
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const streamIntent = this.readStreamIntent(request);
    if (streamIntent) return true;
    return super.wantsUpstreamSse(request, context);
  }

  private readStreamIntent(request: UnknownObject): boolean {
    if (request && typeof request === 'object') {
      const body = (request as Record<string, unknown>).body;
      if (body && typeof body === 'object') {
        return Boolean((body as Record<string, unknown>).stream);
      }
      return Boolean((request as Record<string, unknown>).stream);
    }
    return false;
  }
}
