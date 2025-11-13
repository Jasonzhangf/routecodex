import type { CompatibilityConfig } from '../types/compatibility-types.js';
// LLM switch is runtime-dynamic; always use a single conversion-router.

export interface PipelineAssemblerModuleConfig {
  type: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface PipelineAssemblerPipeline {
  id: string;
  modules: {
    llmSwitch: PipelineAssemblerModuleConfig;
    workflow: PipelineAssemblerModuleConfig;
    compatibility?: PipelineAssemblerModuleConfig;
    provider: { type: string; config: Record<string, unknown> };
  };
  settings?: { debugEnabled?: boolean };
}

export interface PipelineAssemblerConfigOut {
  routeTargets: Record<string, Array<{ providerId: string; modelId: string; keyId: string }>>;
  pipelines: PipelineAssemblerPipeline[];
  routePools: Record<string, string[]>;
  routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>;
  authMappings?: Record<string, string>;
}

/**
 * Build pipeline_assembler.config from compatibilityConfig
 * This converts compatibility layer artifacts into the single contract
 * consumed by the passive assembler at runtime.
 */
export function buildPipelineAssemblerConfig(compat: CompatibilityConfig): PipelineAssemblerConfigOut {
  const routeTargets: Record<string, Array<{ providerId: string; modelId: string; keyId: string }>> = {};
  const routePools: Record<string, string[]> = {};
  const routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> = {};
  const pipelines: PipelineAssemblerPipeline[] = [];

  // 1) routeTargets (compact)
  for (const [routeName, targets] of Object.entries(compat.routeTargets || {})) {
    const arr: Array<{ providerId: string; modelId: string; keyId: string }> = [];
    for (const t of targets as any[]) {
      if (!t || typeof t !== 'object') continue;
      const providerId = String((t as any).providerId || '');
      const modelId = String((t as any).modelId || '');
      const keyId = String((t as any).keyId || 'key1');
      if (providerId && modelId) {
        arr.push({ providerId, modelId, keyId });
      }
    }
    routeTargets[routeName] = arr;
  }

  // 2) pipelines from pipelineConfigs (if available); otherwise synthesize
  const pc = (compat.pipelineConfigs || {}) as Record<string, any>;
  const providersNorm = (compat.normalizedConfig?.virtualrouter?.providers || {}) as Record<string, any>;
  const pushPipeline = (providerId: string, modelId: string, keyId: string, cfg: any) => {
    const pipelineId = `${providerId}_${keyId}.${modelId}`;
    // Build provider config
    // Map family type -> concrete module type; keep explicit module types as-is.
    const specifiedType = String(cfg?.provider?.type || '').trim();
    const moduleTypeWhitelist = new Set([
      'openai-provider', 'generic-openai-provider', 'glm-http-provider', 'lmstudio-http',
      'qwen-provider', 'iflow-provider', 'generic-http', 'generic-responses'
    ]);
    const familyToModule: Record<string, string> = {
      openai: 'openai-provider',
      qwen: 'qwen-provider',
      lmstudio: 'lmstudio-http',
      iflow: 'iflow-provider',
      custom: 'generic-http'
    };
    let providerType = 'openai-provider';
    if (specifiedType) {
      const lowered = specifiedType.toLowerCase();
      providerType = moduleTypeWhitelist.has(lowered) ? lowered : (familyToModule[lowered] || 'openai-provider');
    }
    const providerBaseUrl = (cfg?.provider?.baseURL || cfg?.provider?.baseUrl);
    const authObj = (() => {
      const actualKey = cfg?.keyConfig?.actualKey;
      // oauth alias flow: map oauthN alias to oauth token file if possible
      if (/^oauth\d+$/i.test(keyId)) {
        const tokenFile = (compat.normalizedConfig?.virtualrouter?.providers?.[providerId]?.oauth && typeof compat.normalizedConfig.virtualrouter.providers[providerId].oauth === 'object')
          ? (Object.values(compat.normalizedConfig.virtualrouter.providers[providerId].oauth as Record<string, any>)[parseInt(keyId.replace(/[^\d]/g, ''), 10) - 1] as any)?.tokenFile
          : undefined;
        const oauthCfg: Record<string, unknown> = {};
        if (tokenFile) oauthCfg.tokenFile = tokenFile;
        return { type: 'oauth', oauth: oauthCfg } as Record<string, unknown>;
      }
      if (typeof actualKey === 'string' && actualKey.trim()) {
        return { type: 'apikey', apiKey: actualKey } as Record<string, unknown>;
      }
      return { type: 'apikey', alias: keyId } as Record<string, unknown>;
    })();

    const providerConfig: Record<string, unknown> = { type: providerType, config: { auth: authObj } } as any;
    if (providerBaseUrl) { (providerConfig as any).config.baseUrl = providerBaseUrl; }
    (providerConfig as any).config.model = modelId;

    // Always attach a single dynamic conversion-router; do not derive or require user config.
    const llmSwitch = { type: 'llmswitch-conversion-router', config: {} } as const;
    const workflow = cfg?.workflow?.type ? { type: cfg.workflow.type, config: cfg.workflow.config || {}, enabled: cfg.workflow.enabled !== false } : { type: 'streaming-control', config: {} };
    // Standardize compatibility: always use 'compatibility' module; pass moduleType + moduleConfig when present
    const normalizeCompatType = (t?: string): string | undefined => {
      if (!t) return undefined;
      const s = String(t).toLowerCase();
      if (s === 'glm-compatibility' || s === 'glm') return 'glm';
      if (s === 'qwen-compatibility' || s === 'qwen') return 'qwen';
      if (s === 'lmstudio-compatibility' || s === 'lmstudio') return 'lmstudio';
      if (s === 'iflow-compatibility' || s === 'iflow') return 'iflow';
      return s;
    };
    const compatType = normalizeCompatType(cfg?.compatibility?.type ? String(cfg.compatibility.type) : undefined);
    const compatConfig = (cfg?.compatibility?.config && typeof cfg.compatibility.config === 'object') ? (cfg.compatibility.config as Record<string, unknown>) : {};
    const compatibility = compatType ? ({ type: 'compatibility', config: { moduleType: compatType, moduleConfig: compatConfig } } as PipelineAssemblerModuleConfig) : undefined;

    pipelines.push({
      id: pipelineId,
      modules: { llmSwitch, workflow, ...(compatibility ? { compatibility } : {}), provider: providerConfig as any },
      settings: { debugEnabled: true }
    });

    routeMeta[pipelineId] = { providerId, modelId, keyId };
  };

  if (Object.keys(pc).length === 0) {
    throw new Error('compatibility-exporter: pipelineConfigs is empty. Provide explicit pipeline definitions.');
  }

  let pushed = 0;
  for (const [key, cfg] of Object.entries(pc)) {
    const parts = String(key).split('.');
    if (parts.length < 2) { continue; }
    const providerId = parts.shift() as string;
    const keyId = (parts.length >= 2) ? (parts.pop() as string) : 'key1';
    const modelId = parts.join('.');
    if (!providerId || !modelId || !keyId) continue;
    pushPipeline(providerId, modelId, keyId, cfg);
    pushed += 1;
  }

  if (pushed === 0) {
    throw new Error('compatibility-exporter: no valid pipeline definitions were processed. Check pipelineConfigs keys.');
  }

  // 3) routePools from routeTargets
  for (const [routeName, targets] of Object.entries(routeTargets)) {
    routePools[routeName] = (targets || []).map(t => `${t.providerId}_${t.keyId}.${t.modelId}`);
  }

  const totalAssigned = Object.values(routePools).reduce((acc, arr) => acc + ((arr || []).length), 0);
  if (totalAssigned === 0) {
    throw new Error('compatibility-exporter: routePools empty after processing. Ensure routeTargets align with pipelineConfigs.');
  }

  // Ensure every pipeline referenced in routePools exists
  const knownIds = new Set(pipelines.map(p => p.id));
  for (const [routeName, ids] of Object.entries(routePools)) {
    for (const id of ids) {
      if (!knownIds.has(id)) {
        throw new Error(`compatibility-exporter: route "${routeName}" references unknown pipeline "${id}".`);
      }
    }
  }
  // 4) authMappings - flatten from keyMappings (apikey aliases) and oauth token files (if present)
  const authMappings: Record<string, string> = {};
  try {
    const kmGlobal = (compat.keyMappings as any)?.global || {};
    for (const [alias, real] of Object.entries(kmGlobal)) {
      authMappings[String(alias)] = String(real);
    }
  } catch { /* ignore */ }
  try {
    // synthesize oauth alias -> tokenFile path mappings
    for (const [, pCfg] of Object.entries(providersNorm)) {
      const oauth = (pCfg?.oauth && typeof pCfg.oauth === 'object') ? pCfg.oauth as Record<string, any> : {};
      const names = Object.keys(oauth);
      names.forEach((name, i) => {
        const alias = `oauth${i + 1}`;
        const tokenFile = (oauth[name]?.tokenFile) || (oauth[name]?.tokens?.[0]) || '';
        if (tokenFile) authMappings[alias] = String(tokenFile);
      });
    }
  } catch { /* ignore */ }

  return { routeTargets, pipelines, routePools, routeMeta, authMappings };
}
