/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 OpenAIStandard，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { OpenAIStandard } from './openai-standard.js';
import path from 'node:path';
import type { ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { buildResponsesRequestFromChat } from '../../../../../llmswitch/bridge.js';

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
   * 覆写内部发送：/v1/responses 入口时按配置选择上游 SSE 或 JSON。
   * 根据架构约束：Responses 上游不支持 JSON，统一使用 SSE 与上游通信，
   * 但 Provider 必须将上游 SSE 解析为 JSON 再返回 Host（对内一律 JSON）。
   */
  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    // 对于 Responses provider，默认使用上游 SSE 直通：
    //  - 始终通过 postStream 打 /responses（或有效 endpoint）
    //  - 不再依赖额外 env/config 开关
    // Build endpoint and headers
    const endpoint = (this as any).getEffectiveEndpoint();
    const headers = await (this as any).buildRequestHeaders();
    // Ensure Responses beta header is present for upstream compatibility
    try {
      const hasBeta = Object.keys(headers || {}).some(k => k.toLowerCase() === 'openai-beta');
      if (!hasBeta) {
        (headers as any)['OpenAI-Beta'] = 'responses-2024-12-17';
      }
    } catch { /* ignore header injection errors */ }
    const context = (this as any).createProviderContext(); // private in base; access via any
    const targetUrl = `${(this as any).getEffectiveBaseUrl().replace(/\/$/, '')}/${String(endpoint).startsWith('/') ? String(endpoint).slice(1) : String(endpoint)}`;

    // Flatten body (copy of base logic)
    const finalBody = (() => {
      const r: any = request || {};
      const dataObj: any = (r && typeof r === 'object' && 'data' in r && typeof r.data === 'object') ? r.data : r;
      const body: any = { ...dataObj };
      const cfgModel = (this.config as any)?.config?.model;
      const cfgModelId = (this.config as any)?.config?.modelId;
      // Responses provider 始终以配置的实际模型为准：
      //  - 优先使用 config.model（若显式提供）
      //  - 否则回退到 config.modelId（canonical 中的 actualModelId，例如 'gpt-5.1'）
      //  - 若仍无配置，则使用 serviceProfile.defaultModel
      const upstreamModel =
        (typeof cfgModel === 'string' && cfgModel.trim())
          ? cfgModel.trim()
          : (typeof cfgModelId === 'string' && cfgModelId.trim())
            ? cfgModelId.trim()
            : (this as any).serviceProfile.defaultModel;
      body.model = upstreamModel;
      // Responses provider 不在此处处理 max_tokens；保持 llmswitch-core 兼容层的唯一治理入口
      try { if ('metadata' in body) { delete body.metadata; } } catch { /* ignore */ }
      return body;
    })();

    // 若当前请求仍为 Chat 形状（messages 存在且 input 不存在），使用 llmswitch-core 做 Chat → Responses 请求编码
    try {
      const looksResponses = Array.isArray((finalBody as any).input) || typeof (finalBody as any).instructions === 'string';
      const looksChat = Array.isArray((finalBody as any).messages);
      if (!looksResponses && looksChat) {
        const res = await buildResponsesRequestFromChat(finalBody);
        const reqObj = res && typeof res === 'object' && 'request' in res ? (res.request as any) : res;
        if (!reqObj || typeof reqObj !== 'object') {
          throw new Error('buildResponsesRequestFromChat did not return a valid request object');
        }
        // 用 Responses 形状覆盖原始 body（保持 model 为上游模型）
        const currentModel = (finalBody as any).model;
        for (const k of Object.keys(finalBody)) {
          delete (finalBody as any)[k];
        }
        Object.assign(finalBody as any, reqObj);
        if (currentModel) {
          (finalBody as any).model = currentModel;
        }
      }
    } catch (e) {
      // 按 Fail Fast 替代旧的静默回退：直接抛出结构化错误，方便从 provider-error 快照定位
      const err = new Error(`[responses-provider] Chat→Responses request encoding failed: ${(e as any)?.message || String(e)}`);
      (err as any).code = 'responses_request_encoding_error';
      throw err;
    }

    // Responses 上游通常通过 SSE：优先启用 stream=true
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

    // 发送请求（仅使用上游 SSE → 核心转换模块解析为 JSON；不做 JSON 兜底）
    try {
      // 上游 SSE：使用 llmswitch-core 的 ResponsesSseToJsonConverter 解析为 JSON
      const stream = await (this as any).httpClient.postStream(endpoint, finalBody, { ...headers, Accept: 'text/event-stream' });
      // 动态引入转换器（避免编译期硬依赖路径问题）
      const modPath = path.resolve(
        process.cwd(),
        'sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/sse/sse-to-json/index.js'
      );
      const { ResponsesSseToJsonConverter } = await import(modPath);
      const converter = new (ResponsesSseToJsonConverter as any)();
      const json = await converter.convertSseToJson(stream as any, {
        requestId: context.requestId,
        model: (finalBody as any)?.model || 'unknown'
      });
      try {
        await writeProviderSnapshot({ phase: 'provider-response', requestId: context.requestId, data: json ?? null, headers, url: targetUrl });
      } catch { /* non-blocking */ }
      // 统一返回 JSON（对内语义）：与 httpClient.post 返回结构保持一致
      return { data: json, status: 200, statusText: 'OK', headers: { 'x-upstream-mode': 'sse' }, url: targetUrl } as any;
    } catch (error) {
      // 将错误形状化并写入 provider-error 快照，便于分析上游 4xx/5xx
      try {
        const err: any = error;
        const msg = typeof err?.message === 'string' ? err.message : String(err || '');
        const m = msg.match(/HTTP\s+(\d{3})/i);
        const statusCode = m ? parseInt(m[1], 10) : undefined;
        await writeProviderSnapshot({
          phase: 'provider-error',
          requestId: context.requestId,
          data: {
            status: statusCode ?? null,
            error: msg
          },
          headers,
          url: targetUrl
        });
      } catch { /* non-blocking */ }
      throw error;
    }
  }
}

export default ResponsesProvider;
