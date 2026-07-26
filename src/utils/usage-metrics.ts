export type UsageMetrics = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function normalizeUsage(
  value: unknown,
  options?: { sourceProtocol?: string }
): UsageMetrics | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usageRecord =
    record.usageMetadata && typeof record.usageMetadata === 'object'
      ? (record.usageMetadata as Record<string, unknown>)
      : record;

  const readNumeric = (raw: unknown): number | undefined => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

  const basePromptOpenAI = readNumeric(usageRecord.prompt_tokens);
  const basePromptAnthropic =
    readNumeric(usageRecord.input_tokens) ??
    readNumeric(usageRecord.inputTokens) ??
    readNumeric(usageRecord.request_tokens) ??
    readNumeric(usageRecord.requestTokens);
  const basePromptOther =
    readNumeric(usageRecord.promptTokenCount) ??
    readNumeric(usageRecord.promptTokens);

  let cacheRead: number | undefined =
    readNumeric(usageRecord.cache_read_input_tokens);

  if (cacheRead === undefined && usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object') {
    const details = usageRecord.input_tokens_details as Record<string, unknown>;
    const cached = readNumeric(details.cached_tokens);
    if (cached !== undefined) {
      cacheRead = cached;
    }
  }
  if (cacheRead === undefined && usageRecord.prompt_tokens_details && typeof usageRecord.prompt_tokens_details === 'object') {
    const details = usageRecord.prompt_tokens_details as Record<string, unknown>;
    const cached = readNumeric(details.cached_tokens);
    if (cached !== undefined) {
      cacheRead = cached;
    }
  }
  if (cacheRead === undefined) {
    const deepseekCacheHit = readNumeric(usageRecord.prompt_cache_hit_tokens);
    if (deepseekCacheHit !== undefined) {
      cacheRead = deepseekCacheHit;
    }
  }

  const cacheCreation: number | undefined =
    readNumeric(usageRecord.cache_creation_input_tokens);

  const sourceProtocol = options?.sourceProtocol?.toLowerCase();
  const isResponsesProtocol = sourceProtocol === 'openai-responses';
  const isAnthropicProtocol = sourceProtocol === 'anthropic';

  const prompt = basePromptOpenAI !== undefined
    ? basePromptOpenAI
    : isResponsesProtocol
      ? basePromptAnthropic
      : isAnthropicProtocol && basePromptAnthropic !== undefined
        ? basePromptAnthropic + (cacheRead ?? 0)
        : basePromptAnthropic ?? basePromptOther;

  const completion =
    readNumeric(usageRecord.completion_tokens) ??
    readNumeric(usageRecord.output_tokens) ??
    readNumeric(usageRecord.candidatesTokenCount) ??
    readNumeric(usageRecord.completionTokens) ??
    readNumeric(usageRecord.outputTokens) ??
    readNumeric(usageRecord.response_tokens) ??
    readNumeric(usageRecord.responseTokens);

  let total =
    readNumeric(usageRecord.total_tokens) ??
    readNumeric(usageRecord.totalTokenCount) ??
    readNumeric(usageRecord.totalTokens);

  if (prompt !== undefined && completion !== undefined) {
    const expected = prompt + completion;
    if (total === undefined || total < expected) {
      total = expected;
    }
  }

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation
  };
}
