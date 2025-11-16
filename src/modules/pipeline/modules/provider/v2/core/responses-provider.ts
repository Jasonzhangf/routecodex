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

// 动态加载 llmswitch-core：优先使用工作目录下的 vendor/rcc-llmswitch-core/dist，
// （基于当前模块文件所在的 dist 目录推导工程根），Fail Fast 不再静默回退。
async function importCore(subpath: string): Promise<any> {
  const clean = subpath.replace(/\.js$/i, '');
  const filename = `${clean}.js`;
  try {
    const pathMod = await import('path');
    const { pathToFileURL, fileURLToPath } = await import('url');
    // 基于当前编译后文件所在位置推导 dist 根目录，再拼 vendor 路径，避免受 process.cwd() 影响
    const here = fileURLToPath(import.meta.url);
    const dir = pathMod.dirname(here);
    // dist/modules/pipeline/modules/provider/v2/core → package root
    // segments: dist / modules / pipeline / modules / provider / v2 / core  → 7 级
    const packageRoot = pathMod.resolve(dir, '../../../../../../../');
    const vendor = pathMod.resolve(packageRoot, 'vendor', 'rcc-llmswitch-core', 'dist');
    const full = pathMod.join(vendor, filename);
    return await import(pathToFileURL(full).href);
  } catch (e) {
    const msg = (e as any)?.message || String(e);
    throw new Error(`[responses-provider] import failed: rcc-llmswitch-core/${filename}: ${msg}`);
  }
}

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

    // 若当前请求仍为 Chat 形状（messages 存在且 input 不存在），使用 llmswitch-core 做 Chat → Responses 请求编码
    try {
      const looksResponses = Array.isArray((finalBody as any).input) || typeof (finalBody as any).instructions === 'string';
      const looksChat = Array.isArray((finalBody as any).messages);
      if (!looksResponses && looksChat) {
        const bridgeMod = await importCore('v2/conversion/responses/responses-openai-bridge');
        const builder = bridgeMod as any;
        if (typeof builder.buildResponsesRequestFromChat === 'function') {
          const res = builder.buildResponsesRequestFromChat(finalBody);
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
        } else {
          throw new Error('buildResponsesRequestFromChat not found in bridge module');
        }
      }
    } catch (e) {
      // 按 Fail Fast 替代旧的静默回退：直接抛出结构化错误，方便从 provider-error 快照定位
      const err = new Error(`[responses-provider] Chat→Responses request encoding failed: ${(e as any)?.message || String(e)}`);
      (err as any).code = 'responses_request_encoding_error';
      throw err;
    }

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
    try {
      const stream = await (this as any).httpClient.postStream(endpoint, finalBody, { ...headers, Accept: 'text/event-stream' });
      // 记录一个简单的 provider-response 快照，标记为 SSE
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: { mode: 'sse', model: (finalBody as any)?.model ?? null },
          headers,
          url: targetUrl
        });
      } catch { /* non-blocking */ }
      // Return a stream token object for BasePipeline to convert to Responses SSE
      return { __sse_stream: stream } as any;
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
