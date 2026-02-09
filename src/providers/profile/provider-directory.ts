import type { ProviderFamilyLookupInput } from './profile-contracts.js';

const KNOWN_FAMILIES = new Set([
  'openai',
  'responses',
  'anthropic',
  'gemini',
  'gemini-cli',
  'iflow',
  'qwen',
  'glm',
  'lmstudio',
  'antigravity',
  'mock'
]);

function normalizeToken(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length ? normalized : undefined;
}

function extractTopLevel(value?: string): string | undefined {
  const token = normalizeToken(value);
  if (!token) {
    return undefined;
  }
  const [head] = token.split('.');
  return head || token;
}

export function resolveProviderFamilyFromDirectory(input: ProviderFamilyLookupInput): string | undefined {
  const explicitFamily = normalizeToken(input.providerFamily);
  if (explicitFamily) {
    return explicitFamily;
  }

  const candidates = [
    normalizeToken(input.providerId),
    extractTopLevel(input.providerId),
    normalizeToken(input.providerKey),
    extractTopLevel(input.providerKey),
    normalizeToken(input.providerType),
    extractTopLevel(input.providerType),
    normalizeToken(input.oauthProviderId),
    extractTopLevel(input.oauthProviderId)
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (KNOWN_FAMILIES.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
