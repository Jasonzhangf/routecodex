#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const ROUTECODEX_BASE = (process.env.RCC_LOOP_ROUTECODEX_BASE || 'http://127.0.0.1:5555/v1').replace(/\/$/, '');
const ROUTECODEX_ROOT = ROUTECODEX_BASE.replace(/\/v1$/, '');
const ROUTECODEX_KEY = process.env.RCC_LOOP_ROUTECODEX_KEY || process.env.ROUTECODEX_API_KEY || 'routecodex-test';
const RESP_PROVIDER_ID = process.env.RCC_LOOP_RESP_PROVIDER || 'lmstudio';
const RESP_MODEL = process.env.RCC_LOOP_RESP_MODEL;
const CHAT_MODEL = process.env.RCC_LOOP_CHAT_MODEL;
const ANTH_PROVIDER_ID = process.env.RCC_LOOP_ANTHROPIC_PROVIDER || 'glm-anthropic';
const ANTH_MODEL = process.env.RCC_LOOP_ANTHROPIC_MODEL;
const USE_PROXY_CAPTURE = process.env.RCC_LOOP_USE_PROXY === '1' || process.argv.includes('--use-proxy-capture');
const PROXY_CAPTURE_ROOT = process.env.RCC_LOOP_PROXY_CAPTURE_DIR || path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses', 'sse-proxy');

const ENABLE_RESPONSES = !process.argv.includes('--skip-responses');
const ENABLE_CHAT = !process.argv.includes('--skip-chat');
const ENABLE_ANTHROPIC = !process.argv.includes('--skip-anthropic');

const PROVIDER_CONFIG_FILES = ['config.v1.json', 'config.json', 'merged-config.5555.json'];
const DROP_KEYS = new Set([
  'id',
  'created',
  'created_at',
  'timestamp',
  'sequence_number',
  'response_id',
  'request_id',
  'server_timing',
  'latency_ms'
]);

function resolveSecretValue(value) {
  if (!value || typeof value !== 'string') return value;
  const match = value.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
  if (!match) return value;
  const [, envName, fallback] = match;
  return process.env[envName] ?? (fallback ?? '');
}

function loadProviderEntry(providerId) {
  const providerRoot = path.join(os.homedir(), '.routecodex', 'provider', providerId);
  for (const name of PROVIDER_CONFIG_FILES) {
    const full = path.join(providerRoot, name);
    if (!fs.existsSync(full)) continue;
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    const candidates = doc?.virtualrouter?.providers || {};
    if (Object.keys(candidates).length === 0) continue;
    const direct = candidates[providerId];
    const entry = direct || Object.values(candidates)[0];
    if (!entry) continue;
    const modelId = entry.defaultModel || entry.model || entry.modelId || Object.keys(entry.models || {})[0];
    const apiKey = resolveSecretValue(entry.auth?.apiKey);
    const headers = entry.headers || {};
    return {
      baseUrl: entry.baseURL || entry.baseUrl,
      model: modelId,
      apiKey,
      headers
    };
  }
  throw new Error(`Unable to locate provider config for ${providerId}`);
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([key]) => !DROP_KEYS.has(key))
      .map(([key, val]) => [key, sanitize(val)]);
    entries.sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

function compareStreams(label, reference, candidate) {
  if (reference.length !== candidate.length) {
    throw new Error(`${label}: event length mismatch (direct=${reference.length}, routecodex=${candidate.length})`);
  }
  for (let i = 0; i < reference.length; i++) {
    const refNorm = sanitize(reference[i]);
    const candNorm = sanitize(candidate[i]);
    const refJson = JSON.stringify(refNorm);
    const candJson = JSON.stringify(candNorm);
    if (refJson !== candJson) {
      const refStr = JSON.stringify(refNorm, null, 2);
      const candStr = JSON.stringify(candNorm, null, 2);
      throw new Error(`${label}: event #${i + 1} mismatch\nDirect: ${refStr}\nRouteCodex: ${candStr}`);
    }
  }
}

function compareRawFrames(label, reference, candidate) {
  if (reference.length !== candidate.length) {
    throw new Error(`${label}: frame length mismatch (upstream=${reference.length}, routecodex=${candidate.length})`);
  }
  for (let i = 0; i < reference.length; i++) {
    const ref = reference[i];
    const cand = candidate[i];
    if (ref !== cand) {
      throw new Error(`${label}: frame #${i + 1} mismatch\nUpstream: ${ref}\nRouteCodex: ${cand}`);
    }
  }
}

function listProxyCaptures() {
  try {
    const entries = fs.readdirSync(PROXY_CAPTURE_ROOT, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(PROXY_CAPTURE_ROOT, entry.name));
  } catch {
    return [];
  }
}

function splitSseFrames(text) {
  if (!text) return [];
  return text
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

async function waitForNewProxyCapture(prevList, timeoutMs = 15000) {
  const prevSet = new Set(prevList);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = fs.readdirSync(PROXY_CAPTURE_ROOT, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(PROXY_CAPTURE_ROOT, e.name));
      const candidate = dirs.find((dir) => !prevSet.has(dir));
      if (candidate) {
        const logPath = path.join(candidate, 'response.sse.log');
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf8');
          return {
            id: path.basename(candidate),
            events: splitSseFrames(content)
          };
        }
      }
    } catch {
      /* ignore read errors */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for proxy capture; ensure responses-sse-proxy is running and provider baseURL points to it.');
}

async function captureRouteSseFrames(payload) {
  const routeUrl = `${ROUTECODEX_BASE}/responses`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${ROUTECODEX_KEY}`,
    'OpenAI-Beta': 'responses-2024-12-17',
    'X-Route-Hint': 'default'
  };
  const res = await fetch(routeUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`RouteCodex responses request failed (${res.status}): ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (chunk) {
        frames.push(chunk);
      }
    }
  }
  buffer += decoder.decode(new Uint8Array(), { stream: false });
  if (buffer.trim()) {
    frames.push(buffer.trim());
  }
  return frames;
}

async function captureResponsesStream(client, payload, label) {
  const stream = await client.responses.stream(payload);
  const events = [];
  for await (const event of stream) {
    if (event) events.push(event);
  }
  console.log(`${label}: captured ${events.length} responses events`);
  return events;
}

async function captureChatStream(client, payload, label) {
  const stream = await client.chat.completions.create({ ...payload, stream: true });
  const events = [];
  for await (const chunk of stream) {
    if (chunk) events.push(chunk);
  }
  console.log(`${label}: captured ${events.length} chat chunks`);
  return events;
}

async function captureAnthropicStream(client, payload, label) {
  const stream = await client.messages.create({ ...payload, stream: true });
  const events = [];
  for await (const event of stream) {
    if (event) events.push(event);
  }
  console.log(`${label}: captured ${events.length} anthropic events`);
  return events;
}

function buildResponsesPayload(modelId) {
  return {
    model: modelId,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '请用中文写出一首五言绝句，并保持和缓语气。' }
        ]
      }
    ],
    temperature: 0,
    top_p: 0.1,
    stream: true
  };
}

function buildChatPayload(modelId) {
  return {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a calm assistant who answers in Chinese.' },
      { role: 'user', content: '列出本地开发环境的 3 个注意事项。' }
    ],
    temperature: 0,
    stream: true
  };
}

function buildAnthropicPayload(modelId) {
  return {
    model: modelId,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: '请一步一步说明如何配置一个支持 SSE 的反向代理。'
      }
    ]
  };
}

function createOpenAIClient(baseUrl, apiKey, extraHeaders = {}) {
  return new OpenAI({
    apiKey: apiKey || 'sk-verify',
    baseURL: baseUrl,
    defaultHeaders: {
      'OpenAI-Beta': 'responses-2024-12-17',
      ...extraHeaders
    }
  });
}

function createAnthropicClient(baseUrl, apiKey) {
  return new Anthropic({
    apiKey: apiKey || 'anthropic-verify',
    baseURL: baseUrl
  });
}

async function verifyResponsesFlow() {
  const provider = loadProviderEntry(RESP_PROVIDER_ID);
  const modelId = RESP_MODEL || provider.model;
  if (!provider.baseUrl || !modelId) {
    throw new Error('responses provider missing baseUrl or model');
  }
  console.log(`Responses loop: provider=${RESP_PROVIDER_ID} model=${modelId}`);
  const payload = buildResponsesPayload(modelId);
  if (USE_PROXY_CAPTURE) {
    const prevCaptures = listProxyCaptures();
    const routedFrames = await captureRouteSseFrames(payload);
    console.log(`RouteCodex responses: captured ${routedFrames.length} SSE frames (raw)`);
    const capture = await waitForNewProxyCapture(prevCaptures);
    console.log(`Proxy capture: ${capture.id} (${capture.events.length} frames)`);
    compareRawFrames('Responses SSE (proxy)', capture.events, routedFrames);
    return;
  }
  const providerClient = createOpenAIClient(provider.baseUrl, provider.apiKey, provider.headers);
  const routeClient = createOpenAIClient(ROUTECODEX_BASE, ROUTECODEX_KEY);
  const upstreamEvents = await captureResponsesStream(providerClient, payload, 'Provider responses');
  const routedEvents = await captureResponsesStream(routeClient, payload, 'RouteCodex responses');
  compareStreams('Responses SSE', upstreamEvents, routedEvents);
}

async function verifyChatFlow() {
  const provider = loadProviderEntry(RESP_PROVIDER_ID);
  const modelId = CHAT_MODEL || provider.model;
  if (!provider.baseUrl || !modelId) {
    throw new Error('chat provider missing baseUrl or model');
  }
  console.log(`Chat loop: provider=${RESP_PROVIDER_ID} model=${modelId}`);
  const payload = buildChatPayload(modelId);
  const providerClient = createOpenAIClient(provider.baseUrl, provider.apiKey, provider.headers);
  const routeClient = createOpenAIClient(ROUTECODEX_BASE, ROUTECODEX_KEY);
  const upstreamEvents = await captureChatStream(providerClient, payload, 'Provider chat');
  const routedEvents = await captureChatStream(routeClient, payload, 'RouteCodex chat');
  compareStreams('Chat SSE', upstreamEvents, routedEvents);
}

async function verifyAnthropicFlow() {
  const provider = loadProviderEntry(ANTH_PROVIDER_ID);
  const modelId = ANTH_MODEL || provider.model;
  if (!provider.baseUrl || !modelId) {
    throw new Error('anthropic provider missing baseUrl or model');
  }
  console.log(`Anthropic loop: provider=${ANTH_PROVIDER_ID} model=${modelId}`);
  const payload = buildAnthropicPayload(modelId);
  const providerClient = createAnthropicClient(provider.baseUrl, provider.apiKey);
  const routeClient = createAnthropicClient(ROUTECODEX_ROOT || ROUTECODEX_BASE, ROUTECODEX_KEY);
  const upstream = await captureAnthropicStream(providerClient, payload, 'Provider anthropic');
  const routed = await captureAnthropicStream(routeClient, payload, 'RouteCodex anthropic');
  compareStreams('Anthropic SSE', upstream, routed);
}

async function main() {
  if (!ENABLE_RESPONSES && !ENABLE_CHAT && !ENABLE_ANTHROPIC) {
    console.log('No scenarios selected; exiting.');
    return;
  }
  if (ENABLE_RESPONSES) {
    await verifyResponsesFlow();
  }
  if (ENABLE_CHAT) {
    await verifyChatFlow();
  }
  if (ENABLE_ANTHROPIC) {
    await verifyAnthropicFlow();
  }
  console.log('✅ SSE loop verification passed for all enabled targets');
}

main().catch((error) => {
  console.error('[verify-sse-loop] failed:', error);
  process.exit(1);
});
