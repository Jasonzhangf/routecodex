import type { CompatibilityConfig } from '../types/compatibility-types.js';
import { getDefaultLLMSwitchType } from '../normalization/provider-normalization.js';

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
    compatibility: PipelineAssemblerModuleConfig;
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
    // Normalize provider module type to registered module names
    const rawType = String(cfg?.provider?.type || providerId);
    const providerType = (() => {
      const t = rawType.toLowerCase();
      const pid = providerId.toLowerCase();
      if (t.includes('qwen') || pid.includes('qwen')) return 'qwen-provider';
      if (t.includes('openai') || pid.includes('openai') || pid.includes('modelscope')) return 'openai-provider';
      if (t.includes('glm') || pid === 'glm') return 'glm-http-provider';
      if (t.includes('lmstudio') || pid.includes('lmstudio')) return 'lmstudio-http';
      if (t.includes('iflow') || pid.includes('iflow')) return 'iflow-provider';
      if (t.includes('generic-http')) return 'generic-http';
      return rawType; // fallback to original
    })();
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

    const deriveLlmswitchConfig = (type: string, existing?: Record<string, unknown>): Record<string, unknown> => {
      if (existing && Object.keys(existing).length > 0) {
        return existing;
      }
      if (type === 'llmswitch-conversion-router') {
        return {
          profilesPath: 'config/conversion/llmswitch-profiles.json',
          defaultProfile: 'openai-chat'
        };
      }
      return {};
    };
    const llmSwitchType = cfg?.llmSwitch?.type
      ? cfg.llmSwitch.type
      : getDefaultLLMSwitchType(String(cfg?.protocols?.input || 'openai'));
    const llmSwitch = {
      type: llmSwitchType,
      config: deriveLlmswitchConfig(llmSwitchType, cfg?.llmSwitch?.config)
    };
    const workflow = cfg?.workflow?.type ? { type: cfg.workflow.type, config: cfg.workflow.config || {}, enabled: cfg.workflow.enabled !== false } : { type: 'streaming-control', config: {} };
    const compatibility = cfg?.compatibility?.type ? { type: cfg.compatibility.type, config: cfg.compatibility.config || {} } : { type: 'field-mapping', config: {} };

    pipelines.push({
      id: pipelineId,
      modules: { llmSwitch, workflow, compatibility, provider: providerConfig as any },
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
