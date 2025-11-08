/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 OpenAIStandard，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { OpenAIStandard } from './openai-standard.js';
import type { ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';

export class ResponsesProvider extends OpenAIStandard {
  /**
   * 使用 OpenAI 基础档案，但将默认 endpoint 改为 /responses。
   */
  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: '/responses'
    } as ServiceProfile;
  }

  /**
   * 覆写内部发送：/v1/responses 入口时强制使用上游 SSE（postStream）。
   */
  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    // 直接复用父类实现，但强制 wantsStream=true when entryEndpoint === '/v1/responses'
    // 通过设置环境变量分支不够直观，这里直接走 SSE 分支。
    const origEnv1 = process.env.ROUTECODEX_RESPONSES_UPSTREAM_SSE;
    const origEnv2 = process.env.RCC_RESPONSES_UPSTREAM_SSE;
    try {
      process.env.ROUTECODEX_RESPONSES_UPSTREAM_SSE = '1';
      return await super["sendRequestInternal"].call(this, request);
    } finally {
      if (origEnv1 === undefined) delete process.env.ROUTECODEX_RESPONSES_UPSTREAM_SSE; else process.env.ROUTECODEX_RESPONSES_UPSTREAM_SSE = origEnv1;
      if (origEnv2 === undefined) delete process.env.RCC_RESPONSES_UPSTREAM_SSE; else process.env.RCC_RESPONSES_UPSTREAM_SSE = origEnv2;
    }
  }
}

export default ResponsesProvider;

