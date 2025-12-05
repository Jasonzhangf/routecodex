/**
 * OpenAI 协议族聚合器
 * - 基于 providerId/providerKey 选择最小家族差异
 * - 复用现有 GLM/LMStudio/iFlow 兼容模块
 * - Qwen 默认保持 OpenAI 形状（禁用“改形状”路径）
 */

import type { CompatAdapter } from '../provider-composite.js';
import type { CompositeContext } from '../provider-composite.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type {
  CompatibilityContext,
  CompatibilityMetadata,
  CompatibilityModule
} from '../../../compat/compatibility-interface.js';
import { CompatibilityModuleFactory } from '../../../compat/compatibility-factory.js';

const compatModuleCache = new Map<string, Promise<CompatibilityModule | null>>();

async function loadCompatModule(profile: string, deps: ModuleDependencies): Promise<CompatibilityModule | null> {
  if (!profile || profile === 'none') {
    return null;
  }
  if (!CompatibilityModuleFactory.isTypeRegistered(profile)) {
    return null;
  }
  if (!compatModuleCache.has(profile)) {
    const promise = CompatibilityModuleFactory.createModule(
      {
        id: `${profile}-${Date.now()}`,
        type: profile,
        providerType: 'openai'
      },
      deps
    ).catch(error => {
      deps.logger?.logModule?.('openai-compat', 'load-error', {
        profile,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    compatModuleCache.set(profile, promise);
  }
  return compatModuleCache.get(profile) || null;
}

function buildCompatContext(
  ctx: CompositeContext,
  direction: 'incoming' | 'outgoing',
  profileId?: string
) {
  const profileLabel =
    typeof profileId === 'string' && profileId.trim().length > 0 && profileId !== 'default'
      ? profileId
      : ctx.pipelineId || ctx.routeName || 'default';
  const meta = ctx.metadata as {
    entryEndpoint?: unknown;
    dataSize?: unknown;
    dataKeys?: unknown;
  } | undefined;
  const rawEntryEndpoint =
    typeof ctx.entryEndpoint === 'string' && ctx.entryEndpoint.trim().length > 0
      ? ctx.entryEndpoint
      : typeof meta?.entryEndpoint === 'string'
        ? meta.entryEndpoint
        : undefined;
  const entryEndpoint = rawEntryEndpoint?.trim() || undefined;
  const dataSize = typeof meta?.dataSize === 'number' ? meta.dataSize : 0;
  const rawDataKeys = Array.isArray(meta?.dataKeys) ? meta.dataKeys : [];
  const dataKeys = rawDataKeys.filter((key): key is string => typeof key === 'string');

  const compatMetadata: CompatibilityMetadata = {
    dataSize,
    dataKeys
  };

  const baseContext: CompatibilityContext = {
    compatibilityId: `compat_${ctx.requestId}`,
    profileId: profileLabel,
    providerType: ctx.providerType,
    providerFamily: ctx.providerFamily || ctx.providerId || 'openai',
    providerId: ctx.providerId,
    direction,
    stage: 'provider-composite',
    requestId: ctx.requestId,
    executionId: ctx.requestId,
    timestamp: Date.now(),
    startTime: Date.now(),
    entryEndpoint,
    metadata: compatMetadata
  };

  return baseContext;
}

function minimalOpenAIRequest(body: UnknownObject): UnknownObject {
  // 确保不修改 OpenAI Chat 形状；做最小安全清理
  const clone: UnknownObject = { ...body };
  // 删除不被上游接受的 envelope 字段
  try {
    if ('metadata' in clone) {
      delete clone.metadata;
    }
  } catch {
    // ignore removal failures
  }
  return clone;
}

function minimalOpenAIResponse<T>(wire: T): T {
  return wire;
}
function passthrough<T>(value: T): T {
  return value;
}

function resolveCompatProfile(ctx: CompositeContext): string {
  const raw = typeof ctx.target?.compatibilityProfile === 'string' ? ctx.target.compatibilityProfile : undefined;
  return raw && raw.trim().length > 0 ? raw.trim().toLowerCase() : '';
}

export function createOpenAICompatAggregator(): CompatAdapter<'openai-chat'> {
  return {
    protocol: 'openai-chat',
    async request(body, ctx, deps) {
      const profile = resolveCompatProfile(ctx);
      if (!profile || profile === 'default') {
        return passthrough(body);
      }
      const module = await loadCompatModule(profile, deps);
      if (!module) {
        return passthrough(body);
      }
      try {
        const compatCtx = buildCompatContext(ctx, 'incoming', profile);
        return await module.processIncoming(minimalOpenAIRequest(body), compatCtx);
      } catch {
        return minimalOpenAIRequest(body);
      }
    },
    async response(wire, ctx, deps) {
      const profile = resolveCompatProfile(ctx);
      if (!profile || profile === 'default') {
        return passthrough(wire);
      }
      const module = await loadCompatModule(profile, deps);
      if (!module) {
        return passthrough(wire);
      }
      const payload = wire && typeof wire === 'object' ? (wire as UnknownObject) : undefined;
      if (!payload) {
        return passthrough(wire);
      }
      try {
        const compatCtx = buildCompatContext(ctx, 'outgoing', profile);
        return await module.processOutgoing(payload, compatCtx);
      } catch {
        return minimalOpenAIResponse(wire);
      }
    }
  };
}

export default createOpenAICompatAggregator;
