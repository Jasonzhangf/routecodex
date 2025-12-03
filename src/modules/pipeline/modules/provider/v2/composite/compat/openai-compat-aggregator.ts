/**
 * OpenAI 协议族聚合器
 * - 基于 providerId/providerKey 选择最小家族差异
 * - 复用现有 GLM/LMStudio/iFlow 兼容模块
 * - Qwen 默认保持 OpenAI 形状（禁用“改形状”路径）
 */

import type { CompatAdapter } from '../provider-composite.js';
import type { CompositeContext } from '../provider-composite.js';
import type { ModuleDependencies } from '../../../../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../../../../types/common-types.js';
import type { CompatibilityModule } from '../../compatibility/compatibility-interface.js';
import { CompatibilityModuleFactory } from '../../compatibility/compatibility-factory.js';

const compatModuleCache = new Map<string, Promise<CompatibilityModule | null>>();

async function loadCompatModule(profile: string, deps: ModuleDependencies): Promise<CompatibilityModule | null> {
  if (!profile || profile === 'none') return null;
  if (!CompatibilityModuleFactory.isTypeRegistered(profile)) return null;
  if (!compatModuleCache.has(profile)) {
    const promise = CompatibilityModuleFactory.createModule(
      {
        id: `${profile}-${Date.now()}`,
        type: profile,
        providerType: 'openai'
      },
      deps
    )
      .then(module => module)
      .catch(error => {
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
    (typeof profileId === 'string' && profileId.trim().length > 0 && profileId !== 'default')
      ? profileId
      : (ctx.pipelineId || ctx.routeName || 'default');
  return {
    compatibilityId: `compat_${ctx.requestId}`,
    profileId: profileLabel,
    providerType: (ctx.providerId || 'openai'),
    direction,
    stage: 'provider-composite',
    requestId: ctx.requestId,
    executionId: ctx.requestId,
    timestamp: Date.now(),
    startTime: Date.now(),
    entryEndpoint: (ctx as any)?.entryEndpoint,
    metadata: { dataSize: 0, dataKeys: [] }
  } as any; // 兼容旧接口
}

function minimalOpenAIRequest(body: UnknownObject): UnknownObject {
  // 确保不修改 OpenAI Chat 形状；做最小安全清理
  const b: any = { ...(body as any) };
  // 删除不被上游接受的 envelope 字段
  try { if ('metadata' in b) delete b.metadata; } catch {}
  return b;
}

function minimalOpenAIResponse(wire: unknown): unknown { return wire; }
function passthrough<T>(x: T): T { return x; }

function resolveCompatProfile(ctx: CompositeContext): string {
  const raw = (ctx.target as any)?.compatibilityProfile;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().toLowerCase();
  }
  return '';
}

export function createOpenAICompatAggregator(): CompatAdapter<'openai-chat'> {
  return {
    protocol: 'openai-chat',
    async request(body, ctx, deps) {
      const profile = resolveCompatProfile(ctx);
      if (profile && profile !== 'default') {
        const module = await loadCompatModule(profile, deps);
        if (module) {
          try {
            const compatCtx = buildCompatContext(ctx, 'incoming', profile);
            return await module.processIncoming(minimalOpenAIRequest(body), compatCtx);
          } catch {
            return minimalOpenAIRequest(body);
          }
        }
      }
      return passthrough(body);
    },
    async response(wire, ctx, deps) {
      const profile = resolveCompatProfile(ctx);
      if (profile && profile !== 'default') {
        const module = await loadCompatModule(profile, deps);
        if (module) {
          try {
            const compatCtx = buildCompatContext(ctx, 'outgoing', profile);
            return await module.processOutgoing(wire, compatCtx);
          } catch {
            return minimalOpenAIResponse(wire);
          }
        }
      }
      return passthrough(wire);
    }
  };
}

export default createOpenAICompatAggregator;
