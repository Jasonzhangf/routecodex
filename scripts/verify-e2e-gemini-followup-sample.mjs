#!/usr/bin/env node
/**
 * E2E (real upstream) regression:
 * - Replays a known-large OpenAI Responses payload that previously triggered
 *   Gemini `MALFORMED_FUNCTION_CALL` (history tool args not aligned to schema),
 *   causing empty reply + SERVERTOOL_EMPTY_FOLLOWUP (502).
 *
 * Safety: this hits real Antigravity/Gemini upstream and requires local auth.
 * Default: skipped unless ROUTECODEX_VERIFY_ANTIGRAVITY=1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (String(process.env.ROUTECODEX_VERIFY_ANTIGRAVITY || '').trim() !== '1') {
  console.log('[verify:e2e-gemini-followup] skip (set ROUTECODEX_VERIFY_ANTIGRAVITY=1 to enable)');
  process.exit(0);
}

const VERIFY_PORT = process.env.ROUTECODEX_VERIFY_PORT || '5582';
const VERIFY_BASE = process.env.ROUTECODEX_VERIFY_BASE_URL || `http://127.0.0.1:${VERIFY_PORT}`;
const VERIFY_CONFIG =
  process.env.ROUTECODEX_VERIFY_CONFIG ||
  process.env.ROUTECODEX_CONFIG_PATH ||
  `${process.env.HOME || ''}/.routecodex/config.json`;

const DEFAULT_SAMPLE = path.join(
  os.homedir(),
  '.routecodex',
  'codex-samples',
  'openai-responses',
  'antigravity.geetasamodgeetasamoda.gemini-3-pro-high',
  'req_1768707507351_30f4e503',
  'client-request.json'
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readServerApiKeyFromConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const json = raw && raw.trim() ? JSON.parse(raw) : {};
    const apikey = json?.httpserver?.apikey;
    return typeof apikey === 'string' && apikey.trim() ? apikey.trim() : '';
  } catch {
    return '';
  }
}

function buildAuthHeaders(serverApiKey) {
  if (!serverApiKey) return {};
  // middleware accepts x-api-key and many aliases; keep it simple.
  return { 'x-api-key': serverApiKey };
}

function extractResponsesBody(sampleDoc) {
  // common snapshot shapes:
  // - { body: { body: <responses payload>, metadata: ... }, headers: ..., meta: ... }
  // - { data: { body: <responses payload> } }
  // - <responses payload>
  const bodyNode = sampleDoc?.data?.body ?? sampleDoc?.body ?? sampleDoc;
  if (bodyNode && typeof bodyNode === 'object' && typeof bodyNode.body === 'object' && bodyNode.body) {
    return bodyNode.body;
  }
  if (bodyNode && typeof bodyNode === 'object') {
    return bodyNode;
  }
  return undefined;
}

async function waitForServer(timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${VERIFY_BASE}/health`);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[verify:e2e-gemini-followup] server health timeout: ${VERIFY_BASE}/health`);
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

async function waitForFile(filePath, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[verify:e2e-gemini-followup] timeout waiting for ${filePath}`);
}

async function main() {
  if (!VERIFY_CONFIG) {
    throw new Error('Missing ROUTECODEX_VERIFY_CONFIG/ROUTECODEX_CONFIG_PATH');
  }

  const serverApiKey = readServerApiKeyFromConfig(VERIFY_CONFIG);
  if (!serverApiKey) {
    throw new Error(`Missing httpserver.apikey in config: ${VERIFY_CONFIG}`);
  }
  const authHeaders = buildAuthHeaders(serverApiKey);

  const samplePath = process.env.ROUTECODEX_VERIFY_SAMPLE || DEFAULT_SAMPLE;
  if (!fs.existsSync(samplePath)) {
    throw new Error(`Sample file not found: ${samplePath}`);
  }
  const sampleDoc = readJson(samplePath);
  const payload = extractResponsesBody(sampleDoc);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Sample did not contain a JSON request body');
  }

  const requestId =
    (typeof process.env.ROUTECODEX_VERIFY_REQUEST_ID === 'string' && process.env.ROUTECODEX_VERIFY_REQUEST_ID.trim()) ||
    `req_e2e_gemini_followup_${Date.now()}`;

  const serverEnv = {
    ...process.env,
    ROUTECODEX_CONFIG_PATH: VERIFY_CONFIG,
    ROUTECODEX_PORT: VERIFY_PORT,
    ROUTECODEX_V2_HOOKS: '0',
    RCC_V2_HOOKS: '0'
  };

  const debugLogs = String(process.env.ROUTECODEX_VERIFY_DEBUG || '').trim() === '1';
  const serverLogPath = path.join(
    os.tmpdir(),
    `routecodex-verify-e2e-gemini-followup-${Date.now()}.log`
  );
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: 'a' });

  const server = spawn('node', ['dist/index.js'], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (server.stdout) {
    server.stdout.on('data', (chunk) => {
      serverLogStream.write(chunk);
      if (debugLogs) process.stdout.write(chunk);
    });
  }
  if (server.stderr) {
    server.stderr.on('data', (chunk) => {
      serverLogStream.write(chunk);
      if (debugLogs) process.stderr.write(chunk);
    });
  }

  const shutdown = () => {
    if (!server.killed) server.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await waitForServer();

    // Keep headers minimal (we observed certain extra “sample headers” can trigger malformed capture in replay tooling).
    const wantsSse = payload.stream === true;
    const res = await fetch(`${VERIFY_BASE}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: wantsSse ? 'text/event-stream' : 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'x-request-id': requestId,
        ...(authHeaders || {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    if (wantsSse) {
      const frames = await readSse(res);
      const hasErrorFrame = frames.some((frame) => /^event:\\s*error\\b/m.test(frame));
      if (hasErrorFrame) {
        throw new Error(`SSE error frame returned (frames=${frames.length})`);
      }
    } else {
      // ensure it is parseable JSON
      await res.json();
    }

    // Snapshot assertions (ensures we really hit Gemini upstream and validated the mapped payload).
    const snapDir = path.join(
      os.homedir(),
      '.routecodex',
      'codex-samples',
      'openai-responses',
      'antigravity.geetasamodgeetasamoda.gemini-3-pro-high',
      requestId
    );
    const providerReq = path.join(snapDir, 'provider-request.json');
    const providerResp = path.join(snapDir, 'provider-response.json');

    await waitForFile(providerReq);
    await waitForFile(providerResp);

    const providerReqText = fs.readFileSync(providerReq, 'utf8');
    if (/\"cmd\"\s*:/.test(providerReqText)) {
      throw new Error('provider-request still contains legacy tool arg key "cmd"');
    }
    if (!/\"command\"\s*:/.test(providerReqText)) {
      throw new Error('provider-request missing expected tool arg key "command"');
    }
    if (!/\"instructions\"\s*:/.test(providerReqText)) {
      throw new Error('provider-request missing expected tool arg key "instructions"');
    }
    if (!/\"chars\"\s*:/.test(providerReqText)) {
      throw new Error('provider-request missing expected tool arg key "chars"');
    }

    const providerRespJson = readJson(providerResp);
    const raw = providerRespJson?.body?.raw;
    if (typeof raw === 'string' && raw.includes('MALFORMED_FUNCTION_CALL')) {
      throw new Error('provider-response still contains MALFORMED_FUNCTION_CALL');
    }

    console.log(`✅ [verify:e2e-gemini-followup] OK requestId=${requestId}`);
    if (!debugLogs) {
      console.log(`[verify:e2e-gemini-followup] server log: ${serverLogPath}`);
    }
  } finally {
    shutdown();
    try {
      serverLogStream.end();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('[verify:e2e-gemini-followup] failed:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
