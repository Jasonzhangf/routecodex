import type {
  PrepareStreamBodyInput,
  ProviderFamilyProfile,
  ResolveStreamIntentInput
} from '../profile-contracts.js';

function extractStreamFlag(source: unknown): boolean | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const metadata =
    'metadata' in (source as Record<string, unknown>) &&
    typeof (source as { metadata?: unknown }).metadata === 'object'
      ? (source as { metadata?: Record<string, unknown> }).metadata
      : (source as Record<string, unknown>);

  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).stream;
  return typeof value === 'boolean' ? value : undefined;
}

export const anthropicFamilyProfile: ProviderFamilyProfile = {
  id: 'anthropic/default',
  providerFamily: 'anthropic',
  resolveStreamIntent(input: ResolveStreamIntentInput): boolean | undefined {
    const streamFromContext = extractStreamFlag(input.context.metadata);
    if (typeof streamFromContext === 'boolean') {
      return streamFromContext;
    }
    const streamFromRequest = extractStreamFlag(input.request);
    return typeof streamFromRequest === 'boolean' ? streamFromRequest : false;
  },
  prepareStreamBody(input: PrepareStreamBodyInput): void {
    if (input.body && typeof input.body === 'object') {
      (input.body as Record<string, unknown>).stream = true;
    }
  }
};
