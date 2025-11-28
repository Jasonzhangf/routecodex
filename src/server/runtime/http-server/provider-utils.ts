import type { ProviderProtocol } from './types.js';

export function normalizeProviderType(input?: string): string {
  const value = (input || '').toLowerCase();
  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
  if (value.includes('responses')) return 'responses';
  if (value.includes('gemini')) return 'gemini';
  return 'openai';
}

export function mapProviderModule(providerType: string): string {
  switch (normalizeProviderType(providerType)) {
    case 'responses':
      return 'responses-http-provider';
    case 'anthropic':
      return 'anthropic-http-provider';
    case 'gemini':
      return 'gemini-http-provider';
    default:
      return 'openai-http-provider';
  }
}

export function mapProviderProtocol(providerType?: string): ProviderProtocol {
  const normalized = normalizeProviderType(providerType);
  switch (normalized) {
    case 'responses':
      return 'openai-responses';
    case 'anthropic':
      return 'anthropic-messages';
    case 'gemini':
      return 'gemini-chat';
    default:
      return 'openai-chat';
  }
}

export function defaultEndpointForProvider(providerType?: string): string {
  switch (normalizeProviderType(providerType)) {
    case 'responses':
      return '/v1/responses';
    case 'anthropic':
      return '/v1/messages';
    case 'gemini':
      return '/v1beta/models';
    default:
      return '/v1/chat/completions';
  }
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
