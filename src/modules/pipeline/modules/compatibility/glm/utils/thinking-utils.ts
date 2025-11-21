import type { UnknownObject } from '../../../../../../types/common-types.js';

export interface ThinkingModelConfig { enabled: boolean; payload: UnknownObject | null }
export interface ThinkingConfig { enabled: boolean; payload: UnknownObject | null; models: Record<string, ThinkingModelConfig> | null }

export function normalizeThinkingConfig(value: any): ThinkingConfig | null {
  if (!value || typeof value !== 'object') return null;
  const cfg = value as UnknownObject;
  return {
    enabled: cfg.enabled !== false,
    payload: clonePayload(cfg.payload),
    models: normalizePerModel(cfg.models)
  };
}

export function normalizePerModel(value: any): Record<string, ThinkingModelConfig> | null {
  if (!value || typeof value !== 'object') return null;
  const map: Record<string, ThinkingModelConfig> = {};
  for (const [model, raw] of Object.entries(value as UnknownObject)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as UnknownObject;
    map[model] = {
      enabled: cfg.enabled !== false,
      payload: clonePayload(cfg.payload)
    };
  }
  return Object.keys(map).length ? map : null;
}

export function clonePayload(payload: any): UnknownObject | null {
  if (!payload || typeof payload !== 'object') return { type: 'enabled' } as any;
  try { return JSON.parse(JSON.stringify(payload)) as UnknownObject; } catch { return { type: 'enabled' } as any; }
}

export function getModelId(request: Record<string, unknown>): string | null {
  if (request && typeof request === 'object' && request !== null) {
    if ('route' in request && typeof (request as any).route?.modelId === 'string') {
      return (request as any).route.modelId;
    }
    if (typeof (request as any).model === 'string') return (request as any).model;
  }
  return null;
}

export function resolveReasoningPolicy(entryEndpointRaw: string): 'strip' | 'preserve' {
  const policy = String(process.env.RCC_REASONING_POLICY || 'auto').trim().toLowerCase();
  const ep = String(entryEndpointRaw || '').toLowerCase();
  if (policy === 'strip') return 'strip';
  if (policy === 'preserve') return 'preserve';
  if (ep.includes('/v1/responses')) return 'preserve';
  if (ep.includes('/v1/chat/completions')) return 'strip';
  if (ep.includes('/v1/messages')) return 'strip';
  return 'strip';
}

export function flattenAnthropicContent(blocks: any[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === 'string') { const t = block.trim(); if (t) texts.push(t); continue; }
    if (typeof block === 'object') {
      const type = String((block as any).type || '').toLowerCase();
      if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof (block as any).text === 'string') {
        const t = (block as any).text.trim(); if (t) texts.push(t); continue;
      }
      if (Array.isArray((block as any).content)) { texts.push(...flattenAnthropicContent((block as any).content)); continue; }
      if (typeof (block as any).content === 'string') { const t = (block as any).content.trim(); if (t) texts.push(t); continue; }
    }
  }
  return texts;
}

