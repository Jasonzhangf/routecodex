#!/usr/bin/env node
// Replay a codex-samples request against a running RouteCodex instance and
// capture the resulting JSON/SSE output for auditing.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = process.env.ROUTECODEX_BASE || 'http://127.0.0.1:5555';
const DEFAULT_API_KEY = process.env.ROUTECODEX_API_KEY || 'routecodex-test';
const HEADER_DENYLIST = new Set([
  'authorization',
  'content-length',
  'host',
  'accept',
  'content-type'
]);
const CLIENT_REPLAY_METADATA_ALLOWLIST = new Set([
  'clientRequestId',
  'userAgent',
  'clientOriginator',
  'requestSource',
  'experimentFlag',
  'appVersion',
  'sessionId',
  'session_id',
  'conversationId',
  'conversation_id',
  'client_tmux_session_id',
  'rcc_session_client_tmux_session_id',
]);

function usage() {
  console.log(`Usage:
  node scripts/replay-codex-sample.mjs --sample <file> [--label run1] [--base URL] [--key TOKEN] [--dry-run provider-request]
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { base: DEFAULT_BASE_URL, key: DEFAULT_API_KEY };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sample') options.sample = args[++i];
    else if (arg === '--label') options.label = args[++i];
    else if (arg === '--base') options.base = args[++i];
    else if (arg === '--key') options.key = args[++i];
    else if (arg === '--dry-run') options.dryRun = args[++i] || 'provider-request';
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown arg: ${arg}`); usage(); process.exit(1); }
  }
  if (!options.sample) { usage(); process.exit(1); }
  if (options.dryRun && options.dryRun !== 'provider-request') {
    console.error(`Unsupported --dry-run mode: ${options.dryRun}`);
    usage();
    process.exit(1);
  }
  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findNearbyReplayableCandidates(samplePath) {
  const startDir = path.dirname(samplePath);
  const candidates = [];
  const queue = [startDir];
  const seen = new Set();
  let steps = 0;
  while (queue.length && steps < 12) {
    const dir = queue.shift();
    steps += 1;
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower === 'client-request.json'
          || lower === 'http-request.json'
          || (lower === 'request.json' && dir.includes(`${path.sep}runs${path.sep}`))
        ) {
          candidates.push(full);
        }
      } else if (
        entry.isDirectory()
        && (entry.name === 'runs' || entry.name.startsWith('req_') || dir === startDir)
      ) {
        queue.push(full);
      }
    }
    const parent = path.dirname(dir);
    if (parent && parent !== dir && (dir === startDir || path.basename(dir) === 'runs')) {
      queue.push(parent);
    }
  }
  return Array.from(new Set(candidates)).sort();
}

function buildReplayGuidanceError(samplePath, reason) {
  const nearby = findNearbyReplayableCandidates(samplePath);
  const guidance = nearby.length > 0
    ? `Nearby replayable client snapshots:\n- ${nearby.join('\n- ')}`
    : 'No nearby `client-request.json` / `http-request.json` / `runs/**/request.json` found. Re-capture with `--snap-stages "client-request,http-request,provider-request,provider-response"` and replay the client-side snapshot instead.';
  return `${reason}\n${guidance}`;
}

export function normalizeReplayEndpoint(endpoint) {
  if (typeof endpoint !== 'string') {
    return '/v1/responses';
  }
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return '/v1/responses';
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const pathname = typeof url.pathname === 'string' && url.pathname.trim() ? url.pathname.trim() : '/';
    const search = typeof url.search === 'string' ? url.search : '';
    return `${pathname}${search}` || '/v1/responses';
  } catch {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}

function extractEndpoint(doc) {
  return normalizeReplayEndpoint(doc?.data?.url || doc?.url || doc?.endpoint || '/v1/responses');
}

function extractBody(doc) {
  const bodyNode = doc?.data?.body || doc?.body;
  if (!bodyNode) {
    if (typeof doc?.data?.data === 'object') return doc.data.data;
    if (typeof doc?.body?.data === 'object') return doc.body.data;
    return undefined;
  }
  if (typeof bodyNode.body === 'object') return bodyNode.body;
  if (typeof bodyNode === 'object') return bodyNode;
  if (typeof doc?.data?.data === 'object') return doc.data.data;
  if (typeof doc?.body?.data === 'object') return doc.body.data;
  return undefined;
}

export function stripReplayOnlyClientHeadersFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return body;
  }
  const nextMetadata = {};
  let changed = false;
  for (const key of Object.keys(metadata)) {
    if (key === 'clientHeaders') {
      changed = true;
      continue;
    }
    if (!CLIENT_REPLAY_METADATA_ALLOWLIST.has(key)) {
      changed = true;
      continue;
    }
    nextMetadata[key] = metadata[key];
  }
  if (!changed) {
    return body;
  }
  const nextBody = { ...body };
  if (Object.keys(nextMetadata).length === 0) {
    delete nextBody.metadata;
  } else {
    nextBody.metadata = nextMetadata;
  }
  return nextBody;
}

function isProviderRequestShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
  const hasResponsesInput = Array.isArray(body.input) || typeof body.input === 'string';
  const hasSystem = typeof body.system === 'string' || Array.isArray(body.system);
  const looksProviderMetadata =
    body.output_config !== undefined
    || body.thinking !== undefined
    || body.max_tokens !== undefined;
  return (hasMessages && hasSystem) || (hasMessages && !hasResponsesInput && looksProviderMetadata);
}

function normalizeResponsesContentBlock(role, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = typeof value.type === 'string' ? value.type : '';
    if (type) {
      return value;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: value
    };
  }
  return null;
}

export function buildReplayInputFromProviderRequest(body, endpoint) {
  if (!endpoint.includes('/v1/responses')) {
    return body;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = messages.map((message) => {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    const content = Array.isArray(message?.content)
      ? message.content.map((entry) => normalizeResponsesContentBlock(role, entry)).filter(Boolean)
      : [normalizeResponsesContentBlock(role, message?.content)].filter(Boolean);
    return { role, content };
  }).filter((entry) => entry.content.length > 0);

  return {
    model: body.model,
    input,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata } : {}),
    ...(body.stream === true ? { stream: true } : {})
  };
}

function hasOrphanToolHistoryContent(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
    const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    return type === 'tool_result' || type === 'tool_use' || type === 'function_call' || type === 'function_call_output';
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFunctionCallOutputItem(item) {
  return isRecord(item)
    && typeof item.type === 'string'
    && item.type.trim().toLowerCase() === 'function_call_output';
}

export function detectSubmitToolOutputsReplayShape(body, endpoint) {
  if (!endpoint.includes('/v1/responses')) {
    return null;
  }
  if (!isRecord(body)) {
    return null;
  }
  const previousResponseId =
    typeof body.previous_response_id === 'string' && body.previous_response_id.trim()
      ? body.previous_response_id.trim()
      : '';
  const input = Array.isArray(body.input) ? body.input : [];
  if (!previousResponseId || input.length === 0) {
    return null;
  }
  const toolOutputs = input
    .filter((entry) => isFunctionCallOutputItem(entry))
    .map((entry) => ({
      call_id:
        typeof entry.call_id === 'string' && entry.call_id.trim()
          ? entry.call_id.trim()
          : typeof entry.id === 'string' && entry.id.trim()
            ? entry.id.trim()
            : undefined,
      output: Object.prototype.hasOwnProperty.call(entry, 'output') ? entry.output : ''
    }))
    .filter((entry) => typeof entry.call_id === 'string' && entry.call_id);
  if (!toolOutputs.length) {
    return null;
  }
  return {
    endpoint: `/v1/responses/${previousResponseId}/submit_tool_outputs`,
    body: {
      response_id: previousResponseId,
      tool_outputs: toolOutputs
    }
  };
}

function detectStream(doc, requestBody) {
  if (doc?.data?.meta?.stream === true || doc?.meta?.stream === true) return true;
  if (doc?.data?.body?.metadata?.stream === true || doc?.body?.metadata?.stream === true) return true;
  if (requestBody?.stream === true) return true;
  return false;
}

function normalizeReplayHeaderRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const headers = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    const lowered = key.toLowerCase();
    if (HEADER_DENYLIST.has(lowered)) {
      continue;
    }
    if (seen.has(lowered)) {
      continue;
    }
    headers[lowered] = value;
    seen.add(lowered);
  }
  return headers;
}

export function extractSampleHeaders(doc) {
  const topLevel = normalizeReplayHeaderRecord(doc?.headers);
  if (Object.keys(topLevel).length > 0) {
    return topLevel;
  }

  const requestBody = extractBody(doc);
  const metadataHeaders = normalizeReplayHeaderRecord(requestBody?.metadata?.clientHeaders);
  if (Object.keys(metadataHeaders).length > 0) {
    return metadataHeaders;
  }

  return {};
}

function redactAuthorization(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const marker = '::rcc-session:';
  const idx = value.indexOf(marker);
  if (idx >= 0) {
    return `***${value.slice(idx)}`;
  }
  return '***';
}

function extractTmuxSessionIdFromKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const marker = '::rcc-session:';
  const idx = value.lastIndexOf(marker);
  if (idx < 0) return null;
  const start = idx + marker.length;
  if (start >= value.length) return null;
  const nextIdx = value.indexOf('::rcc-sessiond:', start);
  const end = nextIdx >= 0 ? nextIdx : value.length;
  const token = value.slice(start, end).trim();
  return token || null;
}

async function readSse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response is not streamable');
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
      if (chunk) frames.push(chunk);
    }
  }
  buffer += decoder.decode(new Uint8Array(), { stream: false });
  if (buffer.trim()) frames.push(buffer.trim());
  return frames;
}

export async function main() {
  const opts = parseArgs();
  const samplePath = path.resolve(opts.sample);
  const sample = readJson(samplePath);
  let endpoint = extractEndpoint(sample);
  const rawRequestBody = extractBody(sample);
  if (!rawRequestBody) throw new Error('Sample does not contain request body');
  let requestBody = isProviderRequestShape(rawRequestBody)
    ? buildReplayInputFromProviderRequest(rawRequestBody, endpoint)
    : rawRequestBody;
  requestBody = stripReplayOnlyClientHeadersFromBody(requestBody);
  const submitReplayShape = detectSubmitToolOutputsReplayShape(rawRequestBody, endpoint);
  if (submitReplayShape) {
    endpoint = submitReplayShape.endpoint;
    requestBody = submitReplayShape.body;
  }
  if (
    endpoint.includes('/v1/responses')
    && (!Array.isArray(requestBody?.input) || requestBody.input.length === 0)
    && !endpoint.includes('/submit_tool_outputs')
  ) {
    throw new Error(buildReplayGuidanceError(
      samplePath,
      'Replay sample cannot be converted into a valid /v1/responses client payload; provide a client-request snapshot instead of provider-request.json.'
    ));
  }
  if (
    endpoint.includes('/v1/responses')
    && Array.isArray(requestBody?.input)
    && requestBody.input.some((message) => hasOrphanToolHistoryContent(message?.content))
    && !endpoint.includes('/submit_tool_outputs')
  ) {
    throw new Error(buildReplayGuidanceError(
      samplePath,
      'Replay sample still contains tool history blocks (`tool_result`/`tool_use`) without the original client request chain; use a client-request snapshot instead of provider-request.json.'
    ));
  }
  const wantsSse = detectStream(sample, requestBody);
  const requestId = sample?.requestId || sample?.data?.meta?.requestId || `sample_${Date.now()}`;
  const label = opts.label || new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = path.dirname(samplePath);
  const runDir = path.join(baseDir, 'runs', requestId, label);
  ensureDir(runDir);
  const sampleHeaders = extractSampleHeaders(sample);

  const baseUrl = opts.base.replace(/\/$/, '');
  const targetUrl = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const headers = {
    ...sampleHeaders,
    'Content-Type': 'application/json',
    'Accept': opts.dryRun ? 'application/json' : wantsSse ? 'text/event-stream' : 'application/json',
    // Use x-routecodex-api-key to avoid Authorization header sanitization in some clients.
    'x-routecodex-api-key': opts.key,
    'OpenAI-Beta': sampleHeaders['openai-beta'] || 'responses-2024-12-17',
    'X-Route-Hint': sampleHeaders['x-route-hint'] || 'default'
  };
  if (opts.dryRun) {
    headers['x-routecodex-dry-run'] = opts.dryRun;
  }
  const inferredTmux = extractTmuxSessionIdFromKey(opts.key);
  if (inferredTmux && !sampleHeaders['x-routecodex-client-tmux-session-id']) {
    headers['x-routecodex-client-tmux-session-id'] = inferredTmux;
  }

  console.log(`[replay-codex-sample] ${endpoint} → ${targetUrl} (requestId=${requestId}${opts.dryRun ? ` dryRun=${opts.dryRun}` : ''})`);

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  const meta = {
    endpoint,
    targetUrl,
    wantsSse,
    dryRun: opts.dryRun || undefined,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries())
  };
  const debugHeaders = { ...headers };
  if (typeof debugHeaders['x-routecodex-api-key'] === 'string') {
    debugHeaders['x-routecodex-api-key'] = redactAuthorization(debugHeaders['x-routecodex-api-key']);
  }
  fs.writeFileSync(
    path.join(runDir, 'request.json'),
    JSON.stringify({ endpoint, body: requestBody, headers: debugHeaders, dryRun: opts.dryRun || undefined }, null, 2)
  );
  fs.writeFileSync(path.join(runDir, 'response.meta.json'), JSON.stringify(meta, null, 2));

  if (!res.ok) {
    const bodyText = await res.text();
    fs.writeFileSync(path.join(runDir, 'response.error.txt'), bodyText, 'utf8');
    throw new Error(`HTTP ${res.status}: ${bodyText}`);
  }

  if (opts.dryRun) {
    const json = await res.json();
    fs.writeFileSync(path.join(runDir, 'dry-run.provider-request.json'), JSON.stringify(json, null, 2));
    console.log(`[replay-codex-sample] captured provider-request dry-run → ${runDir}`);
  } else if (wantsSse) {
    const frames = await readSse(res);
    fs.writeFileSync(path.join(runDir, 'response.sse.log'), frames.map((f) => `${f}\n\n`).join(''), 'utf8');
    fs.writeFileSync(path.join(runDir, 'response.sse.ndjson'), frames.join('\n'), 'utf8');
    console.log(`[replay-codex-sample] captured ${frames.length} SSE frames → ${runDir}`);
  } else {
    const json = await res.json();
    fs.writeFileSync(path.join(runDir, 'response.json'), JSON.stringify(json, null, 2));
    console.log(`[replay-codex-sample] captured JSON response → ${runDir}`);
  }
}

const isDirectCliEntry = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectCliEntry) {
  main().catch((err) => {
    console.error('[replay-codex-sample] failed:', err);
    process.exit(1);
  });
}
