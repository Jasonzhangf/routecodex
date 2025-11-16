/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 OpenAIStandard，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { OpenAIStandard } from './openai-standard.js';
import type { ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';

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
    // 对于 Responses provider，默认使用上游 SSE 直通：
    //  - 始终通过 postStream 打 /responses（或有效 endpoint）
    //  - 不再依赖额外 env/config 开关
    // Build endpoint and headers
    const endpoint = (this as any).getEffectiveEndpoint();
    const headers = await (this as any).buildRequestHeaders();
    const context = (this as any).createProviderContext(); // private in base; access via any
    const targetUrl = `${(this as any).getEffectiveBaseUrl().replace(/\/$/, '')}/${String(endpoint).startsWith('/') ? String(endpoint).slice(1) : String(endpoint)}`;

    // Flatten body (copy of base logic)
    const finalBody = (() => {
      const r: any = request || {};
      const dataObj: any = (r && typeof r === 'object' && 'data' in r && typeof r.data === 'object') ? r.data : r;
      const body: any = { ...dataObj };
      const cfgModel = (this.config as any)?.config?.model;
      if (typeof cfgModel === 'string' && cfgModel.trim()) {
        body.model = cfgModel.trim();
      } else if (typeof body.model !== 'string' || !body.model) {
        body.model = (this as any).serviceProfile.defaultModel;
      }
      try {
        const reqMt = Number((dataObj as any)?.max_tokens ?? (dataObj as any)?.maxTokens ?? NaN);
        const cfgMt = Number((this.config as any)?.config?.overrides?.maxTokens ?? NaN);
        const envMt = Number(process.env.ROUTECODEX_DEFAULT_MAX_TOKENS || process.env.RCC_DEFAULT_MAX_TOKENS || NaN);
        const fallback = Number.isFinite(cfgMt) && cfgMt > 0 ? cfgMt : (Number.isFinite(envMt) && envMt > 0 ? envMt : 8192);
        const effective = Number.isFinite(reqMt) && reqMt > 0 ? reqMt : fallback;
        (body as any).max_tokens = effective;
        if ('maxTokens' in body) delete (body as any).maxTokens;
      } catch { /* ignore */ }
      try { if ('metadata' in body) { delete body.metadata; } } catch { /* ignore */ }
      return body;
    })();

    // Ensure stream flag for upstream SSE
    (finalBody as any).stream = true;

    // Snapshot provider-request (best-effort)
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: finalBody,
        headers,
        url: targetUrl
      });
    } catch { /* ignore */ }

    // Perform upstream SSE POST
    const stream = await (this as any).httpClient.postStream(endpoint, finalBody, { ...headers, Accept: 'text/event-stream' });
    // Return a stream token object for BasePipeline to convert to Responses SSE
    return { __sse_stream: stream } as any;
  }
}

export default ResponsesProvider;
