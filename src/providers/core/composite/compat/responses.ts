import type { CompatAdapter, CompositeContext } from '../provider-composite.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/modules/provider/interfaces/pipeline-interfaces.js';
import type { CompatibilityModule } from '../../../compat/compatibility-interface.js';
import { CompatibilityModuleFactory } from '../../../compat/compatibility-factory.js';

const moduleCache = new Map<string, Promise<CompatibilityModule | null>>();

function extractCompatibilityProfile(ctx: CompositeContext): string | undefined {
  if (
    ctx.target &&
    typeof ctx.target === 'object' &&
    typeof (ctx.target as any).compatibilityProfile === 'string'
  ) {
    const raw = String((ctx.target as any).compatibilityProfile).trim();
    return raw || undefined;
  }
  return undefined;
}

function buildCompatibilityContext(
  ctx: CompositeContext,
  direction: 'incoming' | 'outgoing',
  profileId: string
) {
  return {
    compatibilityId: `${ctx.requestId}-${direction}`,
    profileId,
    providerType: 'responses',
    direction,
    stage: `responses-compat-${direction}`,
    requestId: ctx.requestId,
    executionId: ctx.requestId,
    timestamp: Date.now(),
    startTime: Date.now(),
    metadata: {
      dataSize: 0,
      dataKeys: []
    }
  };
}

async function resolveModule(profile: string, deps: ModuleDependencies): Promise<CompatibilityModule | null> {
  if (!profile) return null;
  if (!CompatibilityModuleFactory.isTypeRegistered(profile)) {
    return null;
  }
  if (!moduleCache.has(profile)) {
    const promise = CompatibilityModuleFactory.createModule(
      {
        id: `${profile}-${Date.now()}`,
        type: profile,
        providerType: 'responses'
      },
      deps
    )
      .then(module => module)
      .catch(error => {
        deps.logger?.logError?.(error as Error, {
          component: 'responses-compat',
          moduleType: profile,
          providerType: 'responses'
        });
        return null;
      });
    moduleCache.set(profile, promise);
  }
  return moduleCache.get(profile) || null;
}

export const responsesCompat: CompatAdapter<'openai-responses'> = {
  protocol: 'openai-responses',
  async request(body, ctx, deps) {
    const profile = extractCompatibilityProfile(ctx);
    const module = await resolveModule(profile || '', deps);
    if (!module) return body;
    const compatCtx = buildCompatibilityContext(ctx, 'incoming', profile || 'responses');
    return await module.processIncoming(body, compatCtx);
  },
  async response(wire, ctx, deps) {
    const profile = extractCompatibilityProfile(ctx);
    const module = await resolveModule(profile || '', deps);
    if (!module) return wire;
    const compatCtx = buildCompatibilityContext(ctx, 'outgoing', profile || 'responses');
    return await module.processOutgoing(wire, compatCtx);
  }
};

export default responsesCompat;
