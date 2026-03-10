import { type ResponsesProviderConfig, type StreamingPreference } from '../types.js';
import { asRecord } from './utils.js';

/**
 * Normalize responses provider config.
 */
export function normalizeResponsesConfig(
  options: {
    providerId: string;
    providerType: string;
    compatibilityProfile: string;
    provider: Record<string, unknown>;
    node?: Record<string, unknown>;
  }
): ResponsesProviderConfig | undefined {
  const source = options.node ?? asRecord(options.provider.responses);
  const rawStyle =
    typeof source.toolCallIdStyle === 'string' ? source.toolCallIdStyle.trim().toLowerCase() : undefined;
  if (rawStyle === 'fc' || rawStyle === 'preserve') {
    return { toolCallIdStyle: rawStyle as 'fc' | 'preserve' };
  }
  const providerType = typeof options.providerType === 'string' ? options.providerType.trim().toLowerCase() : '';
  if (!providerType.includes('responses')) {
    return undefined;
  }
  const providerId = typeof options.providerId === 'string' ? options.providerId.trim().toLowerCase() : '';
  const compat = typeof options.compatibilityProfile === 'string' ? options.compatibilityProfile.trim().toLowerCase() : '';
  // Default tool-call id style:
  // - Standard OpenAI /v1/responses requires function_call ids to start with "fc_".
  // - LM Studio (OpenAI-compatible) often emits `call_*` ids and expects them to be preserved.
  const isLmstudio = providerId === 'lmstudio' || compat === 'chat:lmstudio';
  return { toolCallIdStyle: isLmstudio ? 'preserve' : 'fc' };
}

/**
 * Resolve provider-level streaming preference.
 */
export function resolveProviderStreamingPreference(
  provider: Record<string, unknown>,
  responsesNode?: Record<string, unknown>
): StreamingPreference | undefined {
  const configNode = asRecord(provider.config);
  const configResponses = configNode ? asRecord(configNode.responses) : undefined;
  return (
    coerceStreamingPreference(
      provider.streaming ?? provider.stream ?? provider.supportsStreaming ?? provider.streamingPreference
    ) ??
    coerceStreamingPreference(responsesNode?.streaming ?? responsesNode?.stream ?? responsesNode?.supportsStreaming) ??
    coerceStreamingPreference(configResponses?.streaming ?? configResponses?.stream)
  );
}

/**
 * Coerce various value types to StreamingPreference.
 */
function coerceStreamingPreference(value: unknown): StreamingPreference | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'always' || normalized === 'auto' || normalized === 'never') {
      return normalized;
    }
    if (normalized === 'true') {
      return 'always';
    }
    if (normalized === 'false') {
      return 'never';
    }
  }
  if (typeof value === 'boolean') {
    return value ? 'always' : 'never';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.mode !== undefined) {
      return coerceStreamingPreference(record.mode);
    }
    if (record.value !== undefined) {
      return coerceStreamingPreference(record.value);
    }
    if (record.enabled !== undefined) {
      return coerceStreamingPreference(record.enabled);
    }
  }
  return undefined;
}
