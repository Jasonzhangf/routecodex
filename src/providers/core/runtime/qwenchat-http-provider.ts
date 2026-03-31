import { HttpTransportProvider } from './http-transport-provider.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  buildQwenChatSendPlan,
  collectQwenSseAsOpenAiResult,
  createOpenAiMappedSseStream,
  DEFAULT_QWENCHAT_BASE_URL,
  DEFAULT_QWENCHAT_COMPLETION_ENDPOINT,
  extractQwenChatPayload,
  getQwenBaxiaTokens
} from './qwenchat-http-provider-helpers.js';

type BxCacheState = {
  tokenCache: {
    bxUa: string;
    bxUmidToken: string;
    bxV: string;
  } | null;
  tokenCacheTime: number;
};

const bxCacheState: BxCacheState = {
  tokenCache: null,
  tokenCacheTime: 0
};

export class QwenChatHttpProvider extends HttpTransportProvider {
  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'qwenchat',
        baseUrl: String(config.config.baseUrl || DEFAULT_QWENCHAT_BASE_URL).trim() || DEFAULT_QWENCHAT_BASE_URL,
        overrides: {
          ...(config.config.overrides || {}),
          endpoint: String(config.config.overrides?.endpoint || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT).trim() || DEFAULT_QWENCHAT_COMPLETION_ENDPOINT
        }
      }
    };
    super(cfg, dependencies, 'qwenchat-http-provider');
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const payload = extractQwenChatPayload(request);
    const baseUrl = this.getEffectiveBaseUrl().replace(/\/$/, '');
    const baxiaTokens = await getQwenBaxiaTokens(bxCacheState);

    const sendPlan = await buildQwenChatSendPlan({
      baseUrl,
      payload,
      baxiaTokens
    });

    const upstreamStream = await this.httpClient.postStream(
      sendPlan.completionUrl,
      sendPlan.completionBody,
      sendPlan.completionHeaders
    );

    if (payload.stream) {
      const mappedStream = createOpenAiMappedSseStream({
        upstreamStream,
        model: payload.model
      });
      return {
        __sse_responses: mappedStream,
        status: 200
      };
    }

    const completion = await collectQwenSseAsOpenAiResult({
      upstreamStream,
      model: payload.model
    });
    return {
      status: 200,
      data: completion
    };
  }

  protected override async performHealthCheck(_url: string): Promise<boolean> {
    const base = this.getEffectiveBaseUrl().replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/api/models`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      return response.ok || response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }
}
