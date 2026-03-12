#!/usr/bin/env node
// Server-side replay for codex-samples /v1/responses requests.
// This script intentionally replays through RouteCodex HTTP server instead of calling provider URLs directly.
//
// Env:
//   RCC_REPLAY_BASE   server base URL (default http://127.0.0.1:5555)
//   RCC_REPLAY_KEY    x-routecodex-api-key (default routecodex-test)
//   RCC_RESP_PROVIDER provider directory filter (optional)
//   RCC_RESP_PICK     request-id/path substring filter (optional)
//   RCC_RESP_REQ      exact request directory name, e.g. req_1773310208018_9b3ec605 (optional)
//
// Output:
//   ~/.routecodex/logs/responses-sse/server-replay_<timestamp>.{request,response,sse,json,chat}.*

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE = process.env.RCC_REPLAY_BASE || 'http://127.0.0.1:5555';
const DEFAULT_KEY =
  process.env.RCC_REPLAY_KEY ||
  process.env.ROUTECODEX_HTTP_APIKEY ||
  process.env.ROUTECODEX_API_KEY ||
  'routecodex-test';
const FILTER_PROVIDER = (process.env.RCC_RESP_PROVIDER || '').trim();
const FILTER_PICK = (process.env.RCC_RESP_PICK || '').trim();
const FILTER_REQ = (process.env.RCC_RESP_REQ || '').trim();
const SAMPLES_ROOT = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'responses-sse');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function healthCheck(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

function findClientRequestFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) {
    return result;
  }
  const providerDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const providerDir of providerDirs) {
    if (FILTER_PROVIDER && !providerDir.name.includes(FILTER_PROVIDER)) {
      continue;
    }
    const providerPath = path.join(root, providerDir.name);
    const reqDirs = fs.readdirSync(providerPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const reqDir of reqDirs) {
      if (FILTER_REQ && reqDir.name !== FILTER_REQ) {
        continue;
      }
      if (FILTER_PICK && !reqDir.name.includes(FILTER_PICK) && !providerDir.name.includes(FILTER_PICK)) {
        continue;
      }
      const clientReq = path.join(providerPath, reqDir.name, 'client-request.json');
      if (!fs.existsSync(clientReq)) {
        continue;
      }
      const stat = fs.statSync(clientReq);
      result.push({
        provider: providerDir.name,
        requestId: reqDir.name,
        file: clientReq,
        mtimeMs: stat.mtimeMs
      });
    }
  }
  result.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return result;
}

function extractRequestBody(doc) {
  if (doc && typeof doc === 'object') {
    if (doc.body && typeof doc.body === 'object' && !Array.isArray(doc.body)) {
      if (doc.body.body && typeof doc.body.body === 'object' && !Array.isArray(doc.body.body)) {
        return doc.body.body;
      }
      return doc.body;
    }
    if (doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)) {
      const data = doc.data;
      if (data.body && typeof data.body === 'object' && !Array.isArray(data.body)) {
        if (data.body.body && typeof data.body.body === 'object' && !Array.isArray(data.body.body)) {
          return data.body.body;
        }
        return data.body;
      }
    }
  }
  return undefined;
}

function extractEntryEndpoint(doc) {
  const endpoint = doc?.meta?.entryEndpoint;
  if (typeof endpoint === 'string' && endpoint.trim().length) {
    return endpoint.trim();
  }
  return '/v1/responses';
}

function extractStreamFlag(doc, body) {
  if (typeof body?.stream === 'boolean') {
    return body.stream;
  }
  if (typeof doc?.meta?.stream === 'boolean') {
    return doc.meta.stream;
  }
  return true;
}

async function readSseFrames(stream) {
  const reader = stream?.getReader?.();
  if (!reader) {
    return [];
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (frame.length) {
        frames.push(frame);
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode(new Uint8Array(), { stream: false });
  if (buffer.trim().length) {
    frames.push(buffer.trim());
  }
  return frames;
}

async function convertSseFramesToJson(frames, requestId, model) {
  try {
    const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/index.js')).href;
    const bridgePath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js')).href;
    const { ResponsesSseToJsonConverter } = await import(convPath);
    const { buildChatResponseFromResponses } = await import(bridgePath);
    const converter = new ResponsesSseToJsonConverter();
    async function* toChunks() {
      for (const frame of frames) {
        yield `${frame}\n\n`;
      }
    }
    const json = await converter.convertSseToJson(toChunks(), {
      requestId,
      model: typeof model === 'string' && model.length ? model : 'unknown'
    });
    const chat = buildChatResponseFromResponses(json);
    return { json, chat };
  } catch {
    return { json: null, chat: null };
  }
}

async function main() {
  const baseUrl = DEFAULT_BASE.replace(/\/$/, '');
  const healthy = await healthCheck(baseUrl);
  if (!healthy) {
    throw new Error(`routecodex server not healthy: ${baseUrl}/health`);
  }

  const candidates = findClientRequestFiles(SAMPLES_ROOT);
  if (!candidates.length) {
    throw new Error(`no client-request samples found under ${SAMPLES_ROOT}`);
  }
  const picked = candidates[0];
  const sample = readJson(picked.file);
  const body = extractRequestBody(sample);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`invalid sample request body: ${picked.file}`);
  }

  const endpoint = extractEntryEndpoint(sample);
  const wantsStream = extractStreamFlag(sample, body);
  const requestBody = { ...body, stream: wantsStream };
  const targetUrl = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  ensureDir(OUT_DIR);
  const runBase = path.join(OUT_DIR, `server-replay_${nowStamp()}`);
  const requestOut = `${runBase}.request.json`;
  const metaOut = `${runBase}.response.meta.json`;
  const sseOut = `${runBase}.response.sse.log`;
  const sseNdjsonOut = `${runBase}.response.sse.ndjson`;
  const jsonOut = `${runBase}.response.json`;
  const chatOut = `${runBase}.chat.json`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': wantsStream ? 'text/event-stream' : 'application/json',
    'OpenAI-Beta': 'responses-2024-12-17',
    'x-routecodex-api-key': DEFAULT_KEY
  };

  fs.writeFileSync(requestOut, JSON.stringify({
    targetUrl,
    endpoint,
    sample: picked,
    headers: { ...headers, 'x-routecodex-api-key': '***' },
    body: requestBody
  }, null, 2));

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });
  fs.writeFileSync(metaOut, JSON.stringify({
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries())
  }, null, 2));
  if (!res.ok) {
    const text = await res.text();
    fs.writeFileSync(`${runBase}.response.error.txt`, text, 'utf-8');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!wantsStream) {
    const json = await res.json();
    fs.writeFileSync(jsonOut, JSON.stringify(json, null, 2));
    console.log('[responses-sse-replay-golden] mode=json sample=%s out=%s', picked.file, jsonOut);
    return;
  }

  const frames = await readSseFrames(res.body);
  fs.writeFileSync(sseOut, frames.map((frame) => `${frame}\n\n`).join(''), 'utf-8');
  fs.writeFileSync(sseNdjsonOut, frames.join('\n'), 'utf-8');
  const converted = await convertSseFramesToJson(
    frames,
    picked.requestId,
    typeof (requestBody).model === 'string' ? (requestBody).model : undefined
  );
  if (converted.json) {
    fs.writeFileSync(jsonOut, JSON.stringify(converted.json, null, 2));
  }
  if (converted.chat) {
    fs.writeFileSync(chatOut, JSON.stringify(converted.chat, null, 2));
  }
  console.log(
    '[responses-sse-replay-golden] mode=sse sample=%s frames=%d sse=%s json=%s chat=%s',
    picked.file,
    frames.length,
    sseOut,
    converted.json ? jsonOut : '(skip)',
    converted.chat ? chatOut : '(skip)'
  );
}

main().catch((err) => {
  console.error('[responses-sse-replay-golden] failed:', err?.message || String(err));
  process.exit(1);
});
