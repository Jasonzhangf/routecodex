/**
 * ResponsesProvider - 真实 OpenAI Responses SSE 透传 Provider
 *
 * 最小实现：继承 ChatHttpProvider，覆写 ServiceProfile 与发送路径，
 * 在 /v1/responses 入口下一律走上游 /responses 并使用 SSE（Accept: text/event-stream）。
 */

import { ChatHttpProvider } from './chat-http-provider.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { buildResponsesRequestFromChat } from '../../../../../llmswitch/bridge.js';
// @ts-ignore - llmswitch-core dist has no ambient types
import { ensureResponsesInstructions } from '../../../../../../../sharedmodule/llmswitch-core/dist/conversion/shared/responses-instructions.js';

export class ResponsesProvider extends ChatHttpProvider {
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
    const settings = this.getResponsesSettings();
    const inboundClientStream = this.normalizeStreamFlag((context?.metadata as any)?.stream);

    const finalBody = (() => {
      const r: any = request || {};
      const dataObj: any = (r && typeof r === 'object' && 'data' in r && typeof r.data === 'object') ? r.data : r;
      const body: any = { ...dataObj };
      const routeModel = (context?.target as any)?.modelId;
      // Responses provider 始终以路由目标提供的实际模型为准，不再依赖 config.model 或默认值
      const upstreamModel =
        (typeof routeModel === 'string' && routeModel.trim())
          ? routeModel.trim()
          : (this as any).serviceProfile.defaultModel;
      body.model = upstreamModel;
      // Responses provider 不在此处处理 max_tokens；保持 llmswitch-core 兼容层的唯一治理入口
      try { if ('metadata' in body) { delete body.metadata; } } catch { /* ignore */ }
      return body;
    })();

    const entryEndpoint =
      (request as any)?.metadata?.entryEndpoint ||
      (context?.metadata as any)?.entryEndpoint ||
      undefined;

    try {
      ensureResponsesInstructions(finalBody as Record<string, unknown>);
    } catch { /* ignore */ }
    if (settings.instructionsMode === 'inline') {
      (finalBody as Record<string, unknown>).__rcc_inline_system_instructions = true;
    }

    const upstreamStream = settings.streaming === 'never' ? false : true;
    const useSse = upstreamStream;
    if (useSse) {
      (finalBody as any).stream = true;
    } else {
      try { delete (finalBody as any).stream; } catch { /* ignore */ }
    }

    const clientRequestedStream =
      settings.streaming === 'always'
        ? true
        : settings.streaming === 'never'
          ? false
          : inboundClientStream === true;

    this.dependencies.logger?.logModule?.(this.id, 'responses-provider-stream-flag', {
      requestId: context.requestId,
      inboundClientStream,
      outboundStream: upstreamStream
    });

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

    // Snapshot provider-request (best-effort)
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: finalBody,
        headers,
        url: targetUrl,
        entryEndpoint
      });
    } catch { /* ignore */ }

    const sendSse = async () => {
      const stream = await (this as any).httpClient.postStream(endpoint, finalBody, {
        ...headers,
        Accept: 'text/event-stream'
      });

      if (clientRequestedStream) {
        return { __sse_stream: stream };
      }

      const modPath = path.join(
        PACKAGE_ROOT,
        'sharedmodule',
        'llmswitch-core',
        'dist',
        'sse',
        'sse-to-json',
        'index.js'
      );
      const { ResponsesSseToJsonConverter } = await import(pathToFileURL(modPath).href);
      const converter = new (ResponsesSseToJsonConverter as any)();
      const json = await converter.convertSseToJson(stream as any, {
        requestId: context.requestId,
        model: (finalBody as any)?.model || 'unknown'
      });
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: json ?? null,
          headers,
          url: targetUrl,
          entryEndpoint
        });
      } catch { /* non-blocking */ }
      return {
        data: json,
        status: 200,
        statusText: 'OK',
        headers: { 'x-upstream-mode': 'sse' },
        url: targetUrl
      } as any;
    };

    try {
      if (useSse) {
        return await sendSse();
      }

      const jsonResponse = await (this as any).httpClient.post(endpoint, finalBody, {
        ...headers,
        Accept: 'application/json'
      });
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: jsonResponse,
          headers,
          url: targetUrl,
          entryEndpoint
        });
      } catch { /* non-blocking */ }
      return jsonResponse;
    } catch (error) {
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
          url: targetUrl,
          entryEndpoint
        });
      } catch { /* non-blocking */ }
      throw error;
    }
  }

  private getResponsesSettings(): ResponsesSettings {
    const cfg = extractResponsesConfig(this.config as any);
    return {
      streaming: cfg.streaming ?? 'auto',
      instructionsMode: cfg.instructionsMode ?? 'default'
    };
  }

  private normalizeStreamFlag(value: unknown): boolean | undefined {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(lowered)) return true;
      if (['false', '0', 'no'].includes(lowered)) return false;
    }
    return undefined;
  }
}

export default ResponsesProvider;

type StreamPref = 'auto' | 'always' | 'never';
type InstructionsMode = 'default' | 'inline';

interface ResponsesSettings {
  streaming: StreamPref;
  instructionsMode: InstructionsMode;
}

function parseStreamPref(value: unknown): StreamPref {
  if (value === true) return 'always';
  if (value === false) return 'never';
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'always') return 'always';
    if (normalized === 'never') return 'never';
    if (['true', '1', 'yes'].includes(normalized)) return 'always';
    if (['false', '0', 'no'].includes(normalized)) return 'never';
  }
  if (value === 'always' || value === 'never') {
    return value;
  }
  return 'auto';
}

function parseInstructionsMode(value: unknown): InstructionsMode {
  if (value === 'inline') return 'inline';
  return 'default';
}

function extractResponsesConfig(config: any): Partial<ResponsesSettings> {
  const responsesCfg = config?.config?.responses;
  if (!responsesCfg || typeof responsesCfg !== 'object') return {};
  return {
    streaming: parseStreamPref(responsesCfg.streaming),
    instructionsMode: parseInstructionsMode(responsesCfg.instructionsMode)
  };
}
function hasSharedmodule(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'sharedmodule', 'llmswitch-core'));
  } catch {
    return false;
  }
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (true) {
    const hasPackageJson = fs.existsSync(path.join(dir, 'package.json'));
    if (hasPackageJson || hasSharedmodule(dir)) {
      return dir;
    }
    if (dir === root) {
      break;
    }
    dir = path.resolve(dir, '..');
  }
  return startDir;
}

function resolveModuleRoot(currentModuleUrl: string): string {
  const current = fileURLToPath(currentModuleUrl || import.meta.url);
  const dirname = path.dirname(current);
  return findPackageRoot(dirname);
}

const PACKAGE_ROOT = resolveModuleRoot(import.meta.url);
