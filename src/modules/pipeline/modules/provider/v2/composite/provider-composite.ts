/**
 * ProviderComposite - 将兼容层内聚到 Provider 的协议敏感子插件
 */

import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import { extractProviderRuntimeMetadata, type ProviderRuntimeMetadata } from '../core/provider-runtime-metadata.js';
import type { TargetMetadata } from '../../../../orchestrator/pipeline-context.js';
import { emitProviderError, buildRuntimeFromCompatContext } from '../utils/provider-error-reporter.js';

// 协议族与协议映射（与 AGENTS.md 一致）
const FAMILY_TO_PROTOCOL: Record<string, string> = {
  openai: 'openai-chat',
  glm: 'openai-chat',
  qwen: 'openai-chat',
  iflow: 'openai-chat',
  lmstudio: 'openai-chat',
  kimi: 'openai-chat',
  modelscope: 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  gemini: 'gemini-chat'
};

export type ProviderType =
  | 'openai'
  | 'glm'
  | 'qwen'
  | 'iflow'
  | 'lmstudio'
  | 'kimi'
  | 'modelscope'
  | 'responses'
  | 'anthropic'
  | 'gemini';
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

export interface CompositeContext {
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType: ProviderType;
  providerProtocol: ProviderProtocol;
  routeName?: string;
  target?: TargetMetadata;
  pipelineId?: string;
}

export interface CompatAdapter<T extends ProviderProtocol> {
  readonly protocol: T;
  request(body: any, ctx: CompositeContext, deps: ModuleDependencies): any;
  response(wire: any, ctx: CompositeContext, deps: ModuleDependencies): any;
}

function normalizeContext(
  runtime: ProviderRuntimeMetadata | undefined,
  providerTypeFromNode?: string
): CompositeContext {
  const rid = runtime?.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const family = (runtime?.providerType || providerTypeFromNode || 'openai').toLowerCase();
  const protocol = (runtime?.providerProtocol || FAMILY_TO_PROTOCOL[family] || 'openai-chat') as ProviderProtocol;
  return {
    requestId: rid,
    providerKey: runtime?.providerKey || runtime?.providerId,
    providerId: runtime?.providerId || runtime?.providerKey,
    providerType: (family as ProviderType),
    providerProtocol: protocol,
    routeName: runtime?.routeName,
    target: runtime?.target,
    pipelineId: runtime?.pipelineId
  };
}

function assertProtocol(ctx: CompositeContext, where: string): void {
  const expected = FAMILY_TO_PROTOCOL[ctx.providerType];
  if (!expected) {
    const err = new Error(`[${where}] ERR_UNSUPPORTED_PROVIDER_TYPE: providerType=${ctx.providerType}`);
    (err as any).code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
    (err as any).details = {
      providerType: ctx.providerType,
      providerProtocol: ctx.providerProtocol,
      routeName: ctx.routeName,
      providerKey: ctx.providerKey,
      requestId: ctx.requestId
    };
    throw err;
  }
  if (ctx.providerProtocol !== expected) {
    const err = new Error(`[${where}] ERR_PROTOCOL_MISMATCH: protocol=${ctx.providerProtocol} expected=${expected}`);
    (err as any).code = 'ERR_PROTOCOL_MISMATCH';
    (err as any).details = {
      providerType: ctx.providerType,
      providerProtocol: ctx.providerProtocol,
      routeName: ctx.routeName,
      providerKey: ctx.providerKey,
      requestId: ctx.requestId
    };
    throw err;
  }
}

function buildShapeDetails(payload: any): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const keys = Object.keys(payload).slice(0, 12);
  let preview: string | undefined;
  try {
    preview = JSON.stringify(payload);
    if (preview.length > 400) preview = `${preview.slice(0, 400)}…`;
  } catch {
    preview = undefined;
  }
  return { keys, preview };
}

function assertShape(payload: any, protocol: ProviderProtocol, where: string): void {
  try {
    if (payload === null || typeof payload !== 'object') {
      const err = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: non-json payload`);
      (err as any).code = 'ERR_COMPAT_PROTOCOL_DRIFT';
      (err as any).details = { protocol, payload: buildShapeDetails(payload) };
      throw err;
    }
    if (protocol === 'openai-chat') {
      // 请求侧：期待 messages[]；响应侧：期待 choices[]。这里做最小校验，Fail Fast。
      const hasMsgs = payload && typeof payload === 'object' && Array.isArray((payload as any).messages);
      const hasChoices = payload && typeof payload === 'object' && Array.isArray((payload as any).choices);
      if (!hasMsgs && !hasChoices) {
        const err = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: openai-chat shape missing (messages/choices)`);
        (err as any).code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        (err as any).details = { protocol, payload: buildShapeDetails(payload) };
        throw err;
      }
    } else if (protocol === 'openai-responses') {
      // 最小检查：存在 input/instructions/response 之一
      const sseMask = !!(payload && typeof payload === 'object' && (payload as any).__sse_responses);
      const ok = sseMask || (
        Array.isArray((payload as any).input) || typeof (payload as any).instructions === 'string' || Array.isArray((payload as any).output)
      );
      if (!ok) {
        const err = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: openai-responses shape missing`);
        (err as any).code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        (err as any).details = { protocol, payload: buildShapeDetails(payload) };
        throw err;
      }
    } else if (protocol === 'anthropic-messages' || protocol === 'gemini-chat') {
      const msgs = (payload as any)?.messages;
      const content = (payload as any)?.content;
      const candidates = (payload as any)?.candidates;
      const ok = Array.isArray(msgs) || Array.isArray(content) || Array.isArray(candidates);
      if (!ok) {
        const err = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: ${protocol} shape missing`);
        (err as any).code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        (err as any).details = { protocol, payload: buildShapeDetails(payload) };
        throw err;
      }
    }
  } catch (e) {
    if (e instanceof Error && !(e as any).code) {
      (e as any).code = 'ERR_COMPAT_PROTOCOL_DRIFT';
    }
    throw e;
  }
}

async function loadCompat(ctx: CompositeContext): Promise<CompatAdapter<any>> {
  switch (ctx.providerProtocol) {
    case 'openai-chat': {
      if (process.env.RCC_TEST_FAKE_OPENAI_COMPAT === '1') {
        const shim: CompatAdapter<'openai-chat'> = {
          protocol: 'openai-chat',
          request: async (body: any) => body,
          response: async (wire: any) => wire
        };
        return shim;
      }
      const mod = await import('./compat/openai-compat-aggregator.js');
      return mod.createOpenAICompatAggregator();
    }
    case 'openai-responses': {
      const mod = await import('./compat/responses.js');
      return mod.responsesCompat;
    }
    case 'anthropic-messages': {
      const mod = await import('./compat/anthropic.js');
      return mod.anthropicCompat;
    }
    case 'gemini-chat': {
      const mod = await import('./compat/gemini.js');
      return mod.geminiCompat;
    }
    default: {
      const err = new Error(`[ProviderComposite] unsupported providerProtocol: ${ctx.providerProtocol}`);
      (err as any).code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
      throw err;
    }
  }
}

export class ProviderComposite {
  /**
   * 出站方向（请求侧）
   */
  static async applyRequest(
    body: UnknownObject,
    opts: { providerType: string; dependencies: ModuleDependencies }
  ): Promise<UnknownObject> {
    const runtime = extractProviderRuntimeMetadata(body);
    const ctx = normalizeContext(runtime, opts.providerType);
    try {
      assertProtocol(ctx, 'composite.request');
      const compat = await loadCompat(ctx);
      // 允许上层使用 { data: {...} } envelope：仅对 data 部分做治理
      const hasEnvelope = body && typeof body === 'object' && 'data' in (body as any) && typeof (body as any).data === 'object';
      const source = hasEnvelope ? ((body as any).data as any) : (body as any);
      const wireCore = await compat.request(source, ctx, opts.dependencies);
      // 最小形状断言（若 compat 做了不当改动，快速失败）
      assertShape(wireCore, ctx.providerProtocol, 'composite.request');
      if (hasEnvelope) {
        const next: any = { ...(body as any) };
        next.data = wireCore;
        return next as UnknownObject;
      }
      return wireCore as UnknownObject;
    } catch (e) {
      emitProviderError({
        error: e,
        stage: 'compat.request',
        runtime: buildRuntimeFromCompatContext(ctx),
        dependencies: opts.dependencies
      });
      throw e;
    }
  }

  /**
   * 返回方向（响应侧）
   * 注意：这里需要 runtime metadata。优先从 metaSource 提取；若无，则允许显式传入 runtime。
   */
  static async applyResponse(
    response: unknown,
    metaSource: UnknownObject | undefined,
    opts: { providerType: string; dependencies: ModuleDependencies; runtime?: ProviderRuntimeMetadata }
  ): Promise<unknown> {
    const runtime = opts.runtime || extractProviderRuntimeMetadata(metaSource || {}) || undefined;
    const ctx = normalizeContext(runtime, opts.providerType);
    try {
      assertProtocol(ctx, 'composite.response');
      const compat = await loadCompat(ctx);
      const std = await compat.response(response, ctx, opts.dependencies);
      // 最小形状断言（对 std 侧，应该是“标准化后的上游 JSON”，允许是 data 外壳内部）；SSE 遮罩允许（responses 协议）
      const root: any = (std as any)?.data ?? std;
      assertShape(root, ctx.providerProtocol, 'composite.response');
      return std;
    } catch (e) {
      emitProviderError({
        error: e,
        stage: 'compat.response',
        runtime: buildRuntimeFromCompatContext(ctx),
        dependencies: opts.dependencies
      });
      throw e;
    }
  }
}

export default ProviderComposite;
