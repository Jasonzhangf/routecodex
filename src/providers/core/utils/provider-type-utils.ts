import type { ProviderType } from '../api/provider-types.js';

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | 'gemini-cli-chat';

const TYPE_TO_PROTOCOL: Record<ProviderType, ProviderProtocol> = {
  openai: 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  gemini: 'gemini-chat',
  'gemini-cli': 'gemini-cli-chat',
  mock: 'openai-chat'
};

const LEGACY_FAMILY_TO_TYPE: Record<string, ProviderType> = {
  glm: 'openai',
  qwen: 'openai',
  iflow: 'openai',
  lmstudio: 'openai',
  kimi: 'openai',
  modelscope: 'openai'
};

export function isProviderType(value: string): value is ProviderType {
  return value === 'openai' || value === 'responses' || value === 'anthropic' || value === 'gemini' || value === 'gemini-cli' || value === 'mock';
}

export function normalizeProviderType(value?: string): ProviderType {
  if (!value || !value.trim()) {
    return 'openai';
  }
  const normalized = value.trim().toLowerCase();
  if (isProviderType(normalized)) {
    return normalized as ProviderType;
  }
  if (normalized in LEGACY_FAMILY_TO_TYPE) {
    return LEGACY_FAMILY_TO_TYPE[normalized as keyof typeof LEGACY_FAMILY_TO_TYPE];
  }
  return 'openai';
}

export function providerTypeToProtocol(type: ProviderType): ProviderProtocol {
  return TYPE_TO_PROTOCOL[type];
}

export function normalizeProviderFamily(...sources: Array<string | undefined>): string {
  for (const source of sources) {
    if (typeof source === 'string' && source.trim()) {
      return source.trim().toLowerCase();
    }
  }
  return 'openai';
}

export const LEGACY_PROVIDER_FAMILY_MAP = Object.freeze({ ...LEGACY_FAMILY_TO_TYPE });
