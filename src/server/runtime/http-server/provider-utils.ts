import type { ProviderProtocol } from './types.js';

const CANONICAL_PROVIDER_TYPES = new Set(['openai', 'responses', 'anthropic', 'gemini']);
const FAMILY_TO_CANONICAL: Record<string, 'openai' | 'responses' | 'anthropic' | 'gemini'> = {
  openai: 'openai',
  glm: 'openai',
  qwen: 'openai',
  iflow: 'openai',
  lmstudio: 'openai',
  chat: 'openai',
  responses: 'responses',
  'openai-responses': 'responses',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini'
};

export function normalizeProviderType(input?: string): string {
  if (typeof input !== 'string') {
    throw new Error('[ProviderType] providerType is required');
  }
  const value = input.trim().toLowerCase();
  if (!value) {
    throw new Error('[ProviderType] providerType is required');
  }
  return value;
}

function canonicalizeProviderType(input?: string): 'openai' | 'responses' | 'anthropic' | 'gemini' {
  if (!input || !input.trim()) {
    return 'openai';
  }
  const normalized = input.trim().toLowerCase();
  if (CANONICAL_PROVIDER_TYPES.has(normalized)) {
    return normalized as 'openai' | 'responses' | 'anthropic' | 'gemini';
  }
  return FAMILY_TO_CANONICAL[normalized] || 'openai';
}

export function resolveProviderIdentity(
  rawType?: string,
  existingFamily?: string
): { providerType: 'openai' | 'responses' | 'anthropic' | 'gemini'; providerFamily: string } {
  const familyCandidate = typeof existingFamily === 'string' && existingFamily.trim()
    ? existingFamily.trim().toLowerCase()
    : undefined;
  const normalizedRaw = rawType && rawType.trim() ? rawType.trim().toLowerCase() : familyCandidate;
  const providerType = canonicalizeProviderType(normalizedRaw || 'openai');
  const providerFamily = familyCandidate || (normalizedRaw ?? providerType) || providerType;
  return {
    providerType,
    providerFamily
  };
}

export function mapProviderModule(providerType: string): string {
  const normalized = normalizeProviderType(providerType);
  if (normalized === 'responses') {
    return 'responses-http-provider';
  }
  if (normalized === 'anthropic') {
    return 'anthropic-http-provider';
  }
  if (normalized === 'gemini') {
    return 'gemini-http-provider';
  }
  if (normalized === 'iflow') {
    return 'iflow-http-provider';
  }
  if (normalized === 'openai' || normalized === 'glm' || normalized === 'qwen' || normalized === 'lmstudio') {
    return 'openai-http-provider';
  }
  throw new Error(`[ProviderType] Unsupported providerType '${providerType}'`);
}

export function mapProviderProtocol(providerType?: string): ProviderProtocol {
  const normalized = normalizeProviderType(providerType);
  if (normalized === 'responses') {
    return 'openai-responses';
  }
  if (normalized === 'anthropic') {
    return 'anthropic-messages';
  }
  if (normalized === 'gemini') {
    return 'gemini-chat';
  }
  if (normalized === 'openai' || normalized === 'glm' || normalized === 'qwen' || normalized === 'iflow' || normalized === 'lmstudio') {
    return 'openai-chat';
  }
  throw new Error(`[ProviderType] Unsupported providerType '${providerType}'`);
}

export function defaultEndpointForProvider(providerType?: string): string {
  const normalized = normalizeProviderType(providerType);
  if (normalized === 'responses') {
    return '/v1/responses';
  }
  if (normalized === 'anthropic') {
    return '/v1/messages';
  }
  if (normalized === 'gemini') {
    return '/v1beta/models';
  }
  if (normalized === 'openai' || normalized === 'glm' || normalized === 'qwen' || normalized === 'iflow' || normalized === 'lmstudio') {
    return '/v1/chat/completions';
  }
  throw new Error(`[ProviderType] Unsupported providerType '${providerType}'`);
}

export function extractFirstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const candidate = value.find((item) => typeof item === 'string' && item.trim());
    return typeof candidate === 'string' ? candidate.trim() : undefined;
  }
  return undefined;
}

export function asRecord<T = Record<string, unknown>>(value: unknown): T {
  return value && typeof value === 'object' ? (value as T) : ({} as T);
}
