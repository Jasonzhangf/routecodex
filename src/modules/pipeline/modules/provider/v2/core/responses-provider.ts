/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 OpenAIStandard，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { OpenAIStandard } from './openai-standard.js';
import type { ServiceProfile } from '../api/provider-types.js';

export class ResponsesProvider extends OpenAIStandard {
  /**
   * 使用 OpenAI 基础档案，但将默认 endpoint 改为 /responses。
   *
   * 注意：一律走统一 JSON 请求路径，禁止上游 SSE 直通，
   * 流式语义由 llmswitch-core 在 Chat 层统一合成。
   */
  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: '/responses'
    } as ServiceProfile;
  }
}

export default ResponsesProvider;
