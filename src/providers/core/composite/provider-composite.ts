/**
 * ProviderComposite - 将兼容层内聚到 Provider 的协议敏感子插件
 */

import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { extractProviderRuntimeMetadata, type ProviderRuntimeMetadata } from '../runtime/provider-runtime-metadata.js';
import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';
import { emitProviderError, buildRuntimeFromCompatContext } from '../utils/provider-error-reporter.js';
import '../../compat/index.js'; // ensure configuration-declared compat modules register before use
import type { ProviderType } from '../api/provider-types.js';
import {
  normalizeProviderFamily,
  normalizeProviderType,
  providerTypeToProtocol,
  type ProviderProtocol
} from '../utils/provider-type-utils.js';

// ProviderProtocol re-export，方便外部引用统一类型
export type { ProviderProtocol };

function deriveProviderFamily(
  runtime: ProviderRuntimeMetadata | undefined,
  hint?: string,
  typeHint?: string
): string {
  return normalizeProviderFamily(
    runtime?.providerFamily,
    runtime?.providerId,
    runtime?.providerKey,
    hint,
    runtime?.providerType,
    typeHint
  );
}

type DecoratedError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

export interface CompositeContext {
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType: ProviderType;
  providerProtocol: ProviderProtocol;
  providerFamily: string;
  routeName?: string;
  target?: TargetMetadata;
  pipelineId?: string;
  metadata?: UnknownObject;
  entryEndpoint?: string;
}

export interface CompatAdapter<T extends ProviderProtocol> {
  readonly protocol: T;
  request(body: UnknownObject, ctx: CompositeContext, deps: ModuleDependencies): Promise<UnknownObject>;
  response(wire: unknown, ctx: CompositeContext, deps: ModuleDependencies): Promise<unknown>;
}

function normalizeContext(
  runtime: ProviderRuntimeMetadata | undefined,
  providerTypeFromNode?: string,
  providerFamilyHint?: string
): CompositeContext {
  const rid = runtime?.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const providerType = normalizeProviderType(runtime?.providerType || providerTypeFromNode);
  const protocol = (runtime?.providerProtocol as ProviderProtocol) || providerTypeToProtocol(providerType);
  const providerFamily = deriveProviderFamily(runtime, providerFamilyHint, providerTypeFromNode || providerType);
  const metadata = runtime?.metadata && typeof runtime.metadata === 'object' ? runtime.metadata as UnknownObject : undefined;
  const rawEntryEndpoint = typeof metadata?.entryEndpoint === 'string' ? metadata.entryEndpoint : undefined;
  const entryEndpoint = rawEntryEndpoint && rawEntryEndpoint.trim().length > 0 ? rawEntryEndpoint.trim() : undefined;
  return {
    requestId: rid,
    providerKey: runtime?.providerKey || runtime?.providerId,
    providerId: runtime?.providerId || runtime?.providerKey,
    providerType,
    providerProtocol: protocol,
    providerFamily,
    routeName: runtime?.routeName,
    target: runtime?.target,
    pipelineId: runtime?.pipelineId,
    metadata,
    entryEndpoint
  };
}

function assertProtocol(ctx: CompositeContext, where: string): void {
  const expected = providerTypeToProtocol(ctx.providerType);
  if (!expected) {
    const err: DecoratedError = new Error(`[${where}] ERR_UNSUPPORTED_PROVIDER_TYPE: providerType=${ctx.providerType}`);
    err.code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
    err.details = {
      providerType: ctx.providerType,
      providerProtocol: ctx.providerProtocol,
      providerFamily: ctx.providerFamily,
      routeName: ctx.routeName,
      providerKey: ctx.providerKey,
      requestId: ctx.requestId
    };
    throw err;
  }
  if (ctx.providerProtocol !== expected) {
    const err: DecoratedError = new Error(`[${where}] ERR_PROTOCOL_MISMATCH: protocol=${ctx.providerProtocol} expected=${expected}`);
    err.code = 'ERR_PROTOCOL_MISMATCH';
    err.details = {
      providerType: ctx.providerType,
      providerProtocol: ctx.providerProtocol,
      providerFamily: ctx.providerFamily,
      routeName: ctx.routeName,
      providerKey: ctx.providerKey,
      requestId: ctx.requestId
    };
    throw err;
  }
}

function buildShapeDetails(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 12);
  let preview: string | undefined;
  try {
    preview = JSON.stringify(record);
    if (preview.length > 400) {
      preview = `${preview.slice(0, 400)}…`;
    }
  } catch {
    preview = undefined;
  }
  return { keys, preview };
}

function assertShape(payload: unknown, protocol: ProviderProtocol, where: string): void {
  try {
    if (payload === null || typeof payload !== 'object') {
      const err: DecoratedError = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: non-json payload`);
      err.code = 'ERR_COMPAT_PROTOCOL_DRIFT';
      err.details = { protocol, payload: buildShapeDetails(payload) };
      throw err;
    }
    const record = payload as Record<string, unknown>;
    if (protocol === 'openai-chat') {
      // 请求侧：期待 messages[]；响应侧：期待 choices[]。这里做最小校验，Fail Fast。
      const hasMsgs = Array.isArray(record.messages as unknown);
      const hasChoices = Array.isArray(record.choices as unknown);
      if (!hasMsgs && !hasChoices) {
        const err: DecoratedError = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: openai-chat shape missing (messages/choices)`);
        err.code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        err.details = { protocol, payload: buildShapeDetails(record) };
        throw err;
      }
    } else if (protocol === 'openai-responses') {
      // 最小检查：存在 input/instructions/response 之一
      const sseMask = Boolean(record.__sse_responses);
      const ok =
        sseMask ||
        Array.isArray(record.input as unknown) ||
        typeof record.instructions === 'string' ||
        Array.isArray(record.output as unknown);
      if (!ok) {
        const err: DecoratedError = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: openai-responses shape missing`);
        err.code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        err.details = { protocol, payload: buildShapeDetails(record) };
        throw err;
      }
    } else if (protocol === 'anthropic-messages' || protocol === 'gemini-chat') {
      const msgs = record.messages;
      const content = record.content;
      const candidates = record.candidates;
      const ok = Array.isArray(msgs as unknown[]) || Array.isArray(content as unknown[]) || Array.isArray(candidates as unknown[]);
      if (!ok) {
        const err: DecoratedError = new Error(`[${where}] ERR_COMPAT_PROTOCOL_DRIFT: ${protocol} shape missing`);
        err.code = 'ERR_COMPAT_PROTOCOL_DRIFT';
        err.details = { protocol, payload: buildShapeDetails(record) };
        throw err;
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      const decorated = e as DecoratedError;
      if (!decorated.code) {
        decorated.code = 'ERR_COMPAT_PROTOCOL_DRIFT';
      }
    }
    throw e;
  }
}

async function loadCompat(ctx: CompositeContext): Promise<CompatAdapter<ProviderProtocol>> {
  switch (ctx.providerProtocol) {
    case 'openai-chat': {
      if (process.env.RCC_TEST_FAKE_OPENAI_COMPAT === '1') {
        const shim: CompatAdapter<'openai-chat'> = {
          protocol: 'openai-chat',
          request: async (body) => body,
          response: async (wire) => wire
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
      const err: DecoratedError = new Error(`[ProviderComposite] unsupported providerProtocol: ${ctx.providerProtocol}`);
      err.code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
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
    opts: { providerType: string; providerFamily?: string; dependencies: ModuleDependencies }
  ): Promise<UnknownObject> {
    const runtime = extractProviderRuntimeMetadata(body);
    const ctx = normalizeContext(runtime, opts.providerType, opts.providerFamily);
    try {
      assertProtocol(ctx, 'composite.request');
      const compat = await loadCompat(ctx);
      // 允许上层使用 { data: {...} } envelope：仅对 data 部分做治理
      const envelopeCandidate = body?.data;
      const hasEnvelope = typeof envelopeCandidate === 'object' && envelopeCandidate !== null;
      const source = hasEnvelope ? (envelopeCandidate as UnknownObject) : body;
      const wireCore = await compat.request(source, ctx, opts.dependencies);
      // 最小形状断言（若 compat 做了不当改动，快速失败）
      assertShape(wireCore, ctx.providerProtocol, 'composite.request');
      if (hasEnvelope) {
        const next: UnknownObject = { ...body, data: wireCore };
        return next;
      }
      return wireCore;
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
    opts: { providerType: string; providerFamily?: string; dependencies: ModuleDependencies; runtime?: ProviderRuntimeMetadata }
  ): Promise<unknown> {
    const runtime = opts.runtime || extractProviderRuntimeMetadata(metaSource || {}) || undefined;
    const ctx = normalizeContext(runtime, opts.providerType, opts.providerFamily);
    try {
      assertProtocol(ctx, 'composite.response');
      const compat = await loadCompat(ctx);
      const std = await compat.response(response, ctx, opts.dependencies);
      // 最小形状断言（对 std 侧，应该是“标准化后的上游 JSON”，允许是 data 外壳内部）；SSE 遮罩允许（responses 协议）
      let root: unknown = std;
      if (root && typeof root === 'object' && 'data' in (root as Record<string, unknown>)) {
        const container = root as Record<string, unknown>;
        root = container.data ?? root;
      }
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
