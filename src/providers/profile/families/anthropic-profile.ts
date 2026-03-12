import type {
  PrepareStreamBodyInput,
  ProviderFamilyProfile,
  ResolveStreamIntentInput
} from '../profile-contracts.js';

type StreamingPreference = 'auto' | 'always' | 'never';

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

function coerceStreamingPreference(value: unknown): StreamingPreference | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
      return normalized;
    }
  }
  return undefined;
}

function extractStreamingPreference(source: unknown): StreamingPreference | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const direct = coerceStreamingPreference(record.streaming ?? record.targetStreaming);
  if (direct) {
    return direct;
  }
  return extractStreamingPreference(record.target);
}

function resolveConfiguredStreamPreference(input: ResolveStreamIntentInput): StreamingPreference | undefined {
  return (
    extractStreamingPreference(input.runtimeMetadata?.target) ??
    extractStreamingPreference(input.runtimeMetadata?.metadata) ??
    extractStreamingPreference(input.context.metadata)
  );
}

export const anthropicFamilyProfile: ProviderFamilyProfile = {
  id: 'anthropic/default',
  providerFamily: 'anthropic',
  resolveStreamIntent(input: ResolveStreamIntentInput): boolean | undefined {
    const configuredStreaming = resolveConfiguredStreamPreference(input);
    if (configuredStreaming === 'always') {
      return true;
    }
    if (configuredStreaming === 'never') {
      return false;
    }
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
