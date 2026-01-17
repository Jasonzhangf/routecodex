import { encoding_for_model } from 'tiktoken';

export type ContextProbeFailure = {
  threshold: number;
  status: number;
  statusText?: string;
  message?: string;
  responseSnippet?: string;
};

export type ContextProbeModelResult = {
  modelId: string;
  thresholds: number[];
  passed: number[];
  maxPassedTokens: number | null;
  firstFailure?: ContextProbeFailure;
};

type ProbeRequestOptions = {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
  maxRetries: number;
};

const encoderCache = new Map<string, ReturnType<typeof encoding_for_model>>();
function getEncoder(model: string): ReturnType<typeof encoding_for_model> {
  const key = model.trim() || 'gpt-4o';
  const existing = encoderCache.get(key);
  if (existing) {
    return existing;
  }
  // tiktoken's TS types restrict this to a known model union; allow override for local experiments.
  const created = encoding_for_model(key as any);
  encoderCache.set(key, created);
  return created;
}

const UNIT_TEXT = 'a ';

export function buildTextForExactTokenCount(targetTokens: number, encoderModel = 'gpt-4o'): string {
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
    throw new Error(`Invalid targetTokens: ${targetTokens}`);
  }
  // We deliberately generate text from plain strings (not decode(tokens)) because
  // decode() is not guaranteed to round-trip back to the same token count via encode().
  //
  // Empirically for tiktoken (e.g. 'gpt-4o'), UNIT_TEXT repeat has stable linear growth:
  //  encode('a '.repeat(n)).length == n + k
  // We detect k at runtime and compute n to hit targetTokens exactly.
  const encoder = getEncoder(encoderModel);

  if (Math.floor(targetTokens) === 1) {
    return 'a';
  }

  const f1 = encoder.encode(UNIT_TEXT).length;
  const f99 = encoder.encode(UNIT_TEXT.repeat(99)).length;
  const f100 = encoder.encode(UNIT_TEXT.repeat(100)).length;
  const slope = f100 - f99;
  const offset = slope === 1 ? (f1 - 1) : 0;
  let repeats = slope === 1 ? Math.max(1, Math.floor(targetTokens) - offset) : Math.max(1, Math.floor(targetTokens));

  // Fine-tune with minimal extra encodes (should converge immediately for slope=1).
  for (let i = 0; i < 20; i++) {
    const text = UNIT_TEXT.repeat(repeats);
    const tokens = encoder.encode(text).length;
    if (tokens === Math.floor(targetTokens)) {
      return text;
    }
    if (tokens < Math.floor(targetTokens)) {
      repeats += Math.max(1, Math.floor(targetTokens) - tokens);
    } else {
      repeats -= Math.max(1, tokens - Math.floor(targetTokens));
      if (repeats <= 0) {
        repeats = 1;
      }
    }
  }

  // Last resort: return best-effort (caller will validate).
  return UNIT_TEXT.repeat(repeats);
}

export function countTokens(text: string, encoderModel = 'gpt-4o'): number {
  const encoder = getEncoder(encoderModel);
  return encoder.encode(text).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOnce(modelId: string, threshold: number, text: string, opts: ProbeRequestOptions): Promise<Response> {
  const fetcher = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    const key = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    const body = {
      model: modelId,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text
            }
          ]
        }
      ],
      stream: false,
      max_output_tokens: 1
    };

    return await fetcher(opts.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithRetries(modelId: string, threshold: number, text: string, opts: ProbeRequestOptions): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const resp = await requestOnce(modelId, threshold, text, opts);
      if (resp.status !== 429 && resp.status !== 503 && resp.status !== 504) {
        return resp;
      }
      lastError = new Error(`HTTP ${resp.status}`);
      // Drain body to free sockets.
      try { await resp.text(); } catch { /* ignore */ }
    } catch (err) {
      lastError = err;
    }
    if (attempt < opts.maxRetries) {
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'request failed'));
}

export async function probeContextForModel(
  modelId: string,
  thresholds: number[],
  {
    endpoint,
    apiKey,
    timeoutMs = 60_000,
    fetcher,
    maxRetries = 2,
    encoderModel = 'gpt-4o'
  }: {
    endpoint: string;
    apiKey?: string;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    maxRetries?: number;
    encoderModel?: string;
  }
): Promise<ContextProbeModelResult> {
  const model = (modelId || '').trim();
  if (!model) {
    throw new Error('probeContextForModel: modelId is required');
  }
  const normalizedEndpoint = (endpoint || '').trim();
  if (!normalizedEndpoint) {
    throw new Error('probeContextForModel: endpoint is required');
  }

  const sorted = thresholds
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!sorted.length) {
    throw new Error('probeContextForModel: thresholds must be non-empty');
  }

  const passed: number[] = [];
  let firstFailure: ContextProbeFailure | undefined;

  for (const threshold of sorted) {
    const text = buildTextForExactTokenCount(threshold, encoderModel);
    const check = countTokens(text, encoderModel);
    if (check !== threshold) {
      throw new Error(`probeContextForModel: internal token mismatch: want=${threshold} got=${check}`);
    }

    let resp: Response;
    try {
      resp = await requestWithRetries(model, threshold, text, {
        endpoint: normalizedEndpoint,
        apiKey,
        timeoutMs,
        fetcher,
        maxRetries
      });
    } catch (err) {
      firstFailure = {
        threshold,
        status: 0,
        message: err instanceof Error ? err.message : String(err)
      };
      break;
    }

    if (resp.ok) {
      passed.push(threshold);
      // Drain body to reuse socket; but keep it small.
      try { await resp.text(); } catch { /* ignore */ }
      continue;
    }

    let responseText = '';
    try {
      responseText = await resp.text();
    } catch {
      responseText = '';
    }
    firstFailure = {
      threshold,
      status: resp.status,
      statusText: resp.statusText,
      responseSnippet: responseText ? responseText.slice(0, 2000) : undefined
    };
    break;
  }

  return {
    modelId: model,
    thresholds: sorted,
    passed,
    maxPassedTokens: passed.length ? passed[passed.length - 1]! : null,
    ...(firstFailure ? { firstFailure } : {})
  };
}
