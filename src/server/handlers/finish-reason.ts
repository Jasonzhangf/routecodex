type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractFinishReasonFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  // OpenAI chat completion shape: { choices: [{ finish_reason }] }
  const choices = Array.isArray((body as any).choices) ? ((body as any).choices as unknown[]) : null;
  if (choices && choices.length) {
    const reasons = choices
      .map((c) => (c && typeof c === 'object' ? (c as any).finish_reason : undefined))
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim());
    if (reasons.length === 1) {
      return reasons[0];
    }
    if (reasons.length > 1) {
      return Array.from(new Set(reasons)).join(',');
    }
  }

  // OpenAI Responses shape (best-effort): { status } or { response: { status } }
  const status = typeof (body as any).status === 'string' ? String((body as any).status).trim().toLowerCase() : '';
  if (status) {
    if (status === 'requires_action') return 'tool_calls';
    if (status === 'in_progress' || status === 'streaming') return 'length';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'failed') return 'error';
    if (status === 'completed') return 'stop';
  }

  const meta = isRecord((body as any).metadata) ? ((body as any).metadata as UnknownRecord) : null;
  if (meta && typeof (meta as any).finish_reason === 'string' && String((meta as any).finish_reason).trim()) {
    return String((meta as any).finish_reason).trim();
  }

  return undefined;
}

export function createSseFinishReasonTracker(): {
  observeChunk(chunk: unknown): void;
  getFinishReason(): string | undefined;
} {
  let buffer = '';
  let finishReason: string | undefined;

  const observeJson = (value: unknown) => {
    if (!value) return;
    if (isRecord(value) && isRecord((value as any).response)) {
      const fromNested = extractFinishReasonFromBody((value as any).response);
      if (fromNested) finishReason = fromNested;
    }
    const fromBody = extractFinishReasonFromBody(value);
    if (fromBody) {
      finishReason = fromBody;
    }
  };

  const observeFrame = (frame: string) => {
    const lines = frame.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;
      // Quick filter to reduce parse attempts.
      if (!data.includes('{')) continue;
      try {
        const parsed = JSON.parse(data);
        observeJson(parsed);
      } catch {
        // ignore parse errors; some providers stream partial json or non-json data lines
      }
    }
  };

  const observeChunk = (chunk: unknown) => {
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk && typeof (chunk as any).toString === 'function'
              ? String((chunk as any).toString())
              : '';
      if (!text) return;
      buffer += text;
      // Split by SSE event boundary (blank line).
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) {
          observeFrame(frame);
        }
      }
    } catch {
      // ignore tracker errors; logging must never affect responses
    }
  };

  return {
    observeChunk,
    getFinishReason: () => finishReason
  };
}

