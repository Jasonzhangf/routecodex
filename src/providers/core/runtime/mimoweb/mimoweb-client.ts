/**
 * MiMo Web API Client
 *
 * Low-level client for aistudio.xiaomimimo.com bot chat API.
 * Single cookie auth (serviceToken + userId + phToken).
 * Returns async generator of MimoChunk.
 */

import type { MimoCookieAuth, MimoChunk, MimoBotConfig, MimoUsage } from './mimoweb-types.js';

const API_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';
const CONFIG_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/config';

let cachedBotConfig: MimoBotConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function stripNulBytes(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.replace(/\u0000/g, '');
}

export async function fetchBotConfig(): Promise<MimoBotConfig> {
  const now = Date.now();
  if (cachedBotConfig && now - configCacheTime < CONFIG_CACHE_TTL) {
    return cachedBotConfig;
  }
  const resp = await fetch(CONFIG_URL, {
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Origin: 'https://aistudio.xiaomimimo.com',
      Referer: 'https://aistudio.xiaomimimo.com/',
      'User-Agent': DEFAULT_UA,
    },
  });
  if (!resp.ok) {
    throw new Error('MiMo bot config fetch failed: ' + resp.status);
  }
  const json = (await resp.json()) as { code: number; data: MimoBotConfig };
  cachedBotConfig = json.data;
  configCacheTime = now;
  return cachedBotConfig;
}

export async function resolveModelId(requestedModel: string): Promise<string> {
  try {
    const config = await fetchBotConfig();
    const entry = config.modelConfigListNg.find(
      (m) =>
        m.pageType === 'chat' &&
        (m.model === requestedModel || m.name === requestedModel),
    );
    if (entry) return entry.redirectTo ?? entry.model;
  } catch {
    // fallback to passthrough
  }
  return requestedModel;
}

export async function* callMimoWeb(
  auth: MimoCookieAuth,
  conversationId: string,
  query: string,
  enableThinking: boolean,
  model: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<MimoChunk> {
  const body = {
    msgId: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
    conversationId,
    query,
    modelConfig: {
      model,
      enableThinking,
      webSearchStatus: 'disabled',
    },
    multiMedias: [],
  };

  const url = API_URL + '?xiaomichatbot_ph=' + encodeURIComponent(auth.phToken);
  const resp = await fetch(url, {
    method: 'POST',
    signal: abortSignal,
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'serviceToken=' + auth.serviceToken + '; userId=' + auth.userId + '; xiaomichatbot_ph=' + auth.phToken,
      Origin: 'https://aistudio.xiaomimimo.com',
      Referer: 'https://aistudio.xiaomimimo.com/',
      'User-Agent': DEFAULT_UA,
      'x-timezone': 'Asia/Shanghai',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errorBody = '';
    try {
      errorBody = await resp.text();
    } catch { /* */ }
    throw new Error(
      'MiMo API error: ' + resp.status + ' ' + resp.statusText + ' - ' + errorBody.slice(0, 300),
    );
  }
  if (!resp.body) throw new Error('MiMo API: no response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        event = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        const raw = trimmed.slice(5).trim();
        if (!raw) continue;
        try {
          const data = JSON.parse(raw);
          if (event === 'message') {
            yield { type: 'text', content: stripNulBytes(data.content) };
          } else if (event === 'usage') {
            const usage: MimoUsage = {
              promptTokens: data.promptTokens ?? 0,
              completionTokens: data.completionTokens ?? 0,
              totalTokens: data.totalTokens ?? 0,
              reasoningTokens:
                data.nativeUsage?.completion_tokens_details?.reasoning_tokens ?? 0,
            };
            yield { type: 'usage', usage };
          } else if (event === 'finish') {
            yield { type: 'finish' };
          } else if (event === 'dialogId') {
            yield { type: 'dialogId', content: data.content };
          }
        } catch {
          // skip unparseable SSE data
        }
      }
    }
  }
}
