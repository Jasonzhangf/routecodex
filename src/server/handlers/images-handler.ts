import type { Request, Response } from 'express';
import type { HandlerContext, PipelineExecutionResult } from './types.js';
import {
  nextRequestIdentifiers,
  respondWithPipelineError,
  logRequestStart,
  logRequestComplete,
  logRequestError
} from './handler-utils.js';

type ImageGenerationPayload = {
  prompt?: unknown;
  model?: unknown;
  n?: unknown;
  size?: unknown;
  response_format?: unknown;
  metadata?: unknown;
};

const PIPELINE_CHAT_ENDPOINT = '/v1/chat/completions';

function normalizeInputString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed || '';
}

function clampCount(value: unknown): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.parseInt(normalizeInputString(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(10, parsed));
}

function normalizeResponseFormat(value: unknown): 'url' | 'b64_json' {
  const normalized = normalizeInputString(value).toLowerCase();
  return normalized === 'b64_json' ? 'b64_json' : 'url';
}

function collectImageUrlsFromText(raw: string): string[] {
  const text = normalizeInputString(raw);
  if (!text) {
    return [];
  }
  const urls: string[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const data = (parsed as { data?: unknown }).data;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
          }
          const url = normalizeInputString((item as { url?: unknown }).url);
          if (url && /^https?:\/\//i.test(url)) {
            urls.push(url);
          }
        }
      }
    }
  } catch {
    // ignore non-json text
  }

  const matched = text.match(/https?:\/\/[^\s"')\]}]+/g) || [];
  for (const url of matched) {
    const normalized = normalizeInputString(url);
    if (normalized) {
      urls.push(normalized);
    }
  }
  return Array.from(new Set(urls));
}

async function fetchImageAsBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  return bytes.toString('base64');
}

function extractAssistantContent(result: PipelineExecutionResult): string {
  const body = result.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '';
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length < 1 || !choices[0] || typeof choices[0] !== 'object') {
    return '';
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  return normalizeInputString((message as { content?: unknown }).content);
}

export async function handleImageGenerations(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/images/generations';
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], { entryEndpoint });
  const requestId = providerRequestId;
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as ImageGenerationPayload;
    const prompt = normalizeInputString(payload.prompt);
    if (!prompt) {
      res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
      return;
    }
    const count = clampCount(payload.n);
    const responseFormat = normalizeResponseFormat(payload.response_format);
    const model = normalizeInputString(payload.model) || 'qwenchat.qwen3.6-plus';
    const reqMetadata =
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : {};

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      model,
      count,
      responseFormat
    });

    const pipelineBody = {
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      metadata: {
        ...reqMetadata,
        qwenImageGeneration: {
          enabled: true,
          n: count,
          size: payload.size,
          responseFormat
        }
      }
    };

    const result = await ctx.executePipeline({
      entryEndpoint: PIPELINE_CHAT_ENDPOINT,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: pipelineBody,
      metadata: {
        stream: false,
        clientRequestId,
        providerProtocol: 'openai-chat',
        __raw_request_body: payload
      }
    });

    if ((result.status ?? 200) >= 400) {
      logRequestError(entryEndpoint, requestId, new Error(`upstream failed with status=${result.status ?? 500}`));
      res.status(result.status ?? 500).json((result.body as Record<string, unknown>) || { error: { message: 'upstream error' } });
      return;
    }

    const content = extractAssistantContent(result);
    const urls = collectImageUrlsFromText(content).slice(0, count);
    if (urls.length < 1) {
      res.status(502).json({ error: { message: 'Upstream returned no image URLs', type: 'api_error' } });
      return;
    }

    const created = Math.floor(Date.now() / 1000);
    if (responseFormat === 'b64_json') {
      try {
        const items = await Promise.all(urls.map(async (url) => ({ b64_json: await fetchImageAsBase64(url) })));
        const body = { created, data: items };
        logRequestComplete(entryEndpoint, requestId, 200, body);
        res.status(200).json(body);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        res.status(502).json({ error: { message: reason, type: 'api_error' } });
        return;
      }
    }

    const body = {
      created,
      data: urls.map((url) => ({ url }))
    };
    logRequestComplete(entryEndpoint, requestId, 200, body);
    res.status(200).json(body);
  } catch (error: unknown) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) {
      return;
    }
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: false });
  }
}

export default { handleImageGenerations };
