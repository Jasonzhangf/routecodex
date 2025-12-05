import type { CompatAdapter, CompositeContext } from '../provider-composite.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type {
  CompatibilityContext,
  CompatibilityMetadata,
  CompatibilityModule
} from '../../../compat/compatibility-interface.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { CompatibilityModuleFactory } from '../../../compat/compatibility-factory.js';

const moduleCache = new Map<string, Promise<CompatibilityModule | null>>();

function extractCompatibilityProfile(ctx: CompositeContext): string | undefined {
  const raw = typeof ctx.target?.compatibilityProfile === 'string' ? ctx.target.compatibilityProfile : undefined;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function buildCompatibilityContext(
  ctx: CompositeContext,
  direction: 'incoming' | 'outgoing',
  profileId: string
) {
  const meta = ctx.metadata as {
    entryEndpoint?: unknown;
    dataSize?: unknown;
    dataKeys?: unknown;
  } | undefined;
  const entryEndpoint =
    typeof ctx.entryEndpoint === 'string' && ctx.entryEndpoint.trim()
      ? ctx.entryEndpoint.trim()
      : typeof meta?.entryEndpoint === 'string'
        ? meta.entryEndpoint
        : undefined;
  const dataSize = typeof meta?.dataSize === 'number' ? meta.dataSize : 0;
  const rawDataKeys = Array.isArray(meta?.dataKeys) ? meta.dataKeys : [];
  const dataKeys = rawDataKeys.filter((key): key is string => typeof key === 'string');
  const metadata: CompatibilityMetadata = {
    dataSize,
    dataKeys
  };
  const context: CompatibilityContext = {
    compatibilityId: `${ctx.requestId}-${direction}`,
    profileId,
    providerType: 'responses',
    providerFamily: ctx.providerFamily || ctx.providerId || 'responses',
    providerId: ctx.providerId,
    direction,
    stage: `responses-compat-${direction}`,
    requestId: ctx.requestId,
    executionId: ctx.requestId,
    timestamp: Date.now(),
    startTime: Date.now(),
    entryEndpoint,
    metadata
  };
  return context;
}

async function resolveModule(profile: string, deps: ModuleDependencies): Promise<CompatibilityModule | null> {
  if (!profile) {
    return null;
  }
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
    ).catch(error => {
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
  async request(body: UnknownObject, ctx, deps) {
    const profile = extractCompatibilityProfile(ctx);
    const module = await resolveModule(profile || '', deps);
    if (!module) {
      return body;
    }
    const compatCtx = buildCompatibilityContext(ctx, 'incoming', profile || 'responses');
    return await module.processIncoming(body, compatCtx);
  },
  async response(wire, ctx, deps) {
    const profile = extractCompatibilityProfile(ctx);
    const module = await resolveModule(profile || '', deps);
    if (!module) {
      return wire;
    }
    if (!wire || typeof wire !== 'object') {
      return wire;
    }
    const compatCtx = buildCompatibilityContext(ctx, 'outgoing', profile || 'responses');
    return await module.processOutgoing(wire as UnknownObject, compatCtx);
  }
};

export default responsesCompat;
