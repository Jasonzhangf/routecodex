import { formatUnknownError } from '../../../utils/common-utils.js';

function logStartupReprobeNonBlocking(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(`[provider.startup.reprobe] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from logging.
  }
}

function buildProviderKeyCandidates(providerKey: string, runtimeKey: string): string[] {
  const candidates = new Set<string>();
  const normalizeAlias = (value: string): string => {
    const parts = value.split('.');
    if (parts.length < 3) return value;
    const alias = parts[1].trim();
    const m = alias.match(/^key(\d+)$/i);
    if (!m) return value;
    parts[1] = m[1];
    return parts.join('.');
  };
  const denormalizeAlias = (value: string): string => {
    const parts = value.split('.');
    if (parts.length < 3) return value;
    const alias = parts[1].trim();
    if (!/^\d+$/.test(alias)) return value;
    parts[1] = `key${alias}`;
    return parts.join('.');
  };
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.add(trimmed);
  };

  push(providerKey);
  push(runtimeKey);
  push(normalizeAlias(providerKey));
  push(denormalizeAlias(providerKey));
  push(normalizeAlias(runtimeKey));
  push(denormalizeAlias(runtimeKey));
  return Array.from(candidates);
}

export async function runStartupProviderReprobe(args: {
  server: {
    hubPipeline?: {
      getVirtualRouter?: () => {
        handleProviderSuccess?: (event: unknown) => void;
      } | null;
    } | null;
  };
  providerKey: string;
  runtimeKey: string;
  providerFamily: string;
  instance: { checkHealth(): Promise<boolean> };
}): Promise<void> {
  if (process.env.ROUTECODEX_STARTUP_REPROBE !== '0') {
    if (args.providerFamily === 'windsurf') {
      void runStartupProviderReprobe({ ...args, providerFamily: 'windsurf-background' }).catch((error) => {
        logStartupReprobeNonBlocking('windsurf_async_reprobe', error, {
          providerKey: args.providerKey,
          runtimeKey: args.runtimeKey,
          providerFamily: args.providerFamily
        });
      });
      return;
    }
    let healthy = false;
    try {
      healthy = await args.instance.checkHealth();
    } catch (error) {
      logStartupReprobeNonBlocking('check_health', error, {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        providerFamily: args.providerFamily
      });
      return;
    }
    if (healthy !== true) {
      logStartupReprobeNonBlocking('check_health_not_healthy', 'provider health check returned false', {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        providerFamily: args.providerFamily
      });
      return;
    }

    const virtualRouter = args.server.hubPipeline?.getVirtualRouter?.() ?? null;
    if (!virtualRouter || typeof virtualRouter.handleProviderSuccess !== 'function') {
      logStartupReprobeNonBlocking('virtual_router_unavailable', 'virtual router handleProviderSuccess unavailable', {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey
      });
      return;
    }

    const now = Date.now();
    for (const key of buildProviderKeyCandidates(args.providerKey, args.runtimeKey)) {
      try {
        virtualRouter.handleProviderSuccess({
          runtime: {
            requestId: `startup_reprobe_${now}`,
            providerKey: key,
            routeName: 'startup',
            pipelineId: 'startup'
          },
          timestamp: now
        });
      } catch (error) {
        logStartupReprobeNonBlocking('emit_provider_success', error, {
          providerKey: args.providerKey,
          runtimeKey: args.runtimeKey,
          emittedProviderKey: key
        });
      }
    }
  }
}
