#!/usr/bin/env node
/**
 * Black-box parity test:
 * - Run the same /v1/responses request payload against TWO servers:
 *   1) routecodex dev (repo dist/index.js, linked llmswitch-core main)
 *   2) rcc npm (node_modules/@jsonstudio/rcc/dist/index.js, pinned @jsonstudio/llms)
 * - Both point to a local mock Cloud Code Assist (v1internal) upstream.
 * - Assert:
 *   - client-visible responses are equivalent (canonicalized)
 *   - upstream requests are equivalent (canonicalized; strip nondeterministic ids)
 *
 * This catches "dirty request" regressions and CLI divergence early.
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout (${ms}ms): ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepSortObject(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepSortObject);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = deepSortObject(value[k]);
  return out;
}

function walkJson(value, fn) {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, fn);
    return;
  }
  if (value && typeof value === 'object') {
    fn(value);
    for (const v of Object.values(value)) walkJson(v, fn);
  }
}

function assertNoUndefinedStrings(label, value) {
  const hits = [];
  walkJson(value, (node) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v.trim() === '[undefined]') hits.push(k);
    }
  });
  assert.equal(hits.length, 0, `${label}: found "[undefined]" string fields: ${hits.slice(0, 20).join(', ')}`);
}

function assertNoForbiddenWrapperFields(label, raw) {
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const inner =
    top.request && typeof top.request === 'object' && !Array.isArray(top.request) ? top.request : {};

  for (const key of ['metadata', 'web_search', 'messages', 'stream', 'sessionId', 'action']) {
    assert.equal(Object.prototype.hasOwnProperty.call(top, key), false, `${label}: forbidden top-level ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(inner, key), false, `${label}: forbidden request.${key}`);
  }
}

function canonicalizeUpstream(body) {
  const cloned = jsonClone(body) || {};
  // Antigravity v1internal wrapper: { project, requestId, request, model, userAgent, requestType }
  delete cloned.requestId; // random per request
  delete cloned.action; // never expected
  // inner request:
  if (cloned.request && typeof cloned.request === 'object' && !Array.isArray(cloned.request)) {
    const inner = cloned.request;
    delete inner.action;
    delete inner.metadata;
    delete inner.web_search;
    delete inner.stream;
    delete inner.sessionId;
    // Normalize tool declarations order
    if (Array.isArray(inner.tools)) {
      inner.tools = inner.tools.map((t) => deepSortObject(t));
    }
  }
  return deepSortObject(cloned);
}

function canonicalizeResponses(payload) {
  const cloned = jsonClone(payload) || {};
  // Remove typical non-deterministic ids/timestamps
  delete cloned.id;
  delete cloned.created;
  delete cloned.created_at;
  delete cloned.system_fingerprint;
  delete cloned.request_id;
  // Some conversions include nested response id
  if (cloned.response && typeof cloned.response === 'object') {
    delete cloned.response.id;
    delete cloned.response.created;
  }
  if (Array.isArray(cloned.output)) {
    for (const item of cloned.output) {
      if (item && typeof item === 'object') {
        delete item.id;
      }
    }
  }
  return deepSortObject(cloned);
}

function extractTextFromResponses(body) {
  // Best-effort: pull final text across common shapes.
  if (!body || typeof body !== 'object') return '';
  const direct = typeof body.output_text === 'string' ? body.output_text : '';
  if (direct) return direct;
  const output = Array.isArray(body.output) ? body.output : [];
  const texts = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (c && typeof c === 'object' && c.type === 'output_text' && typeof c.text === 'string') {
        texts.push(c.text);
      }
    }
  }
  return texts.join('');
}

async function startMockUpstream() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      requests.push({ url: url.toString(), headers: req.headers, body: parsed });

      // Minimal OAuth helper compatibility for Antigravity/Gemini CLI.
      if (url.pathname.endsWith('/v1internal:loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: { id: 'test-project' } }));
        return;
      }
      if (url.pathname.endsWith('/v1internal:onboardUser')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: { id: 'test-project' } }));
        return;
      }

      // Minimal schema sanity checks (focus on "dirty request" regressions)
      const requestNode = parsed?.request;
      if (!requestNode || typeof requestNode !== 'object' || Array.isArray(requestNode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing request wrapper' } }));
        return;
      }
      for (const forbidden of ['metadata', 'action', 'web_search', 'stream', 'sessionId']) {
        if (Object.prototype.hasOwnProperty.call(requestNode, forbidden)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `forbidden request.${forbidden}` } }));
          return;
        }
      }

      // Tool schema types should be uppercase (llmswitch-core compat normalizes this)
      const tools = requestNode.tools;
      if (Array.isArray(tools)) {
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) {
            node.forEach(walk);
            return;
          }
          for (const [k, v] of Object.entries(node)) {
            if (k === 'type' && typeof v === 'string') {
              // accept both (some versions may not uppercase); store for diff
              return;
            }
            walk(v);
          }
        };
        walk(tools);
      }

      // Cloud Code Assist stream endpoint
      const isSse = url.pathname.endsWith(':streamGenerateContent') || url.searchParams.get('alt') === 'sse';
      if (isSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        const response = {
          response: {
            candidates: [
              {
                index: 0,
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    { text: 'ok-from-mock' }
                  ]
                }
              }
            ],
            modelVersion: 'mock'
          }
        };
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      // Non-stream fallback
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok-from-mock' }] } }] }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.equal(typeof addr, 'object');
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    requests,
    close: async () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function writeTempConfig({ dir, serverPort, upstreamBaseUrl, tokenFile }) {
  const cfgPath = path.join(dir, `config-${serverPort}.json`);
  const cfg = {
    version: '1.0.0',
    server: { quotaRoutingEnabled: false },
    httpserver: { host: '127.0.0.1', port: serverPort, apikey: 'verify-key' },
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          enabled: true,
          type: 'gemini-cli-http-provider',
          providerType: 'gemini',
          compatibilityProfile: 'chat:gemini',
          baseURL: upstreamBaseUrl,
          auth: {
            type: 'antigravity-oauth',
            entries: [
              { alias: 'test', type: 'antigravity-oauth', tokenFile }
            ]
          },
          models: {
            'gemini-3-pro-high': { supportsStreaming: true }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default-primary',
            priority: 200,
            mode: 'priority',
            targets: ['antigravity.gemini-3-pro-high']
          }
        ],
        thinking: [
          {
            id: 'thinking-primary',
            priority: 200,
            mode: 'priority',
            targets: ['antigravity.gemini-3-pro-high']
          }
        ]
      }
    }
  };
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfgPath;
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(250);
  }
  throw new Error(`server health timeout: ${baseUrl}`);
}

async function runOnceBlackbox(opts) {
  const {
    label,
    entryScript,
    port,
    configPath,
    homeDir,
    antigravityApiBase
  } = opts;

  const env = {
    ...process.env,
    ...(homeDir ? { HOME: homeDir } : {}),
    ROUTECODEX_CONFIG_PATH: configPath,
    ROUTECODEX_PORT: String(port),
    RCC_CONFIG_PATH: configPath,
    RCC_PORT: String(port),
    ROUTECODEX_V2_HOOKS: '0',
    RCC_V2_HOOKS: '0',
    // Disable ManagerDaemon (quota/health background tasks) so the parity run is isolated and deterministic.
    ROUTECODEX_USE_MOCK: '1',
    RCC_USE_MOCK: '1',
    ...(antigravityApiBase
      ? {
          ROUTECODEX_ANTIGRAVITY_API_BASE: antigravityApiBase,
          RCC_ANTIGRAVITY_API_BASE: antigravityApiBase
        }
      : {}),
    // keep verbose logs off
    ROUTECODEX_LOG_LEVEL: process.env.ROUTECODEX_LOG_LEVEL || 'warn',
    RCC_LOG_LEVEL: process.env.RCC_LOG_LEVEL || 'warn'
  };

  const child = spawn('node', [entryScript], {
    env,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const shutdown = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  try {
    await withTimeout(waitForHealth(baseUrl), 25000, `${label}:waitForHealth`);
    const res = await withTimeout(
      fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': 'verify-key',
          'x-route-hint': 'thinking',
          'x-session-id': 'bb-antigravity-session'
        },
        body: JSON.stringify({
          model: 'gpt-5.2-codex',
          stream: false,
          // Include a tool schema to exercise Gemini tool schema + compat cleaning.
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                description: 'Run a shell command',
                parameters: {
                  type: 'object',
                  properties: {
                    cmd: { type: 'string' }
                  },
                  required: ['cmd']
                }
              }
            }
          ],
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'Say exactly: ok-from-mock' }
              ]
            }
          ]
        })
      }),
      25000,
      `${label}:/v1/responses`
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${label} /v1/responses HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = text.trim() ? JSON.parse(text) : {};
    return { label, response: json };
  } finally {
    shutdown();
    await withTimeout(
      new Promise((resolve) => child.on('exit', () => resolve())),
      15000,
      `${label}:shutdown`
    ).catch(() => {});
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-blackbox-antigravity-'));
  try {
    const tokenFile = path.join(tempDir, 'antigravity-token.json');
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ access_token: 'test_access_token', token_type: 'Bearer', project_id: 'test-project' }, null, 2)
    );

    const upstream = await startMockUpstream();
    try {
      // Run routecodex (dev) then rcc (npm) sequentially against the SAME upstream.
      const cfg1 = writeTempConfig({ dir: tempDir, serverPort: 5591, upstreamBaseUrl: upstream.baseUrl, tokenFile });
      const routecodex = await runOnceBlackbox({
        label: 'routecodex',
        entryScript: 'dist/index.js',
        port: 5591,
        configPath: cfg1,
        homeDir: tempDir,
        antigravityApiBase: upstream.baseUrl
      });

      const cfg2 = writeTempConfig({ dir: tempDir, serverPort: 5592, upstreamBaseUrl: upstream.baseUrl, tokenFile });
      const rcc = await runOnceBlackbox({
        label: 'rcc',
        entryScript: 'node_modules/@jsonstudio/rcc/dist/index.js',
        port: 5592,
        configPath: cfg2,
        homeDir: tempDir,
        antigravityApiBase: upstream.baseUrl
      });

      // Capture the two upstream requests (one per run).
      assert.equal(upstream.requests.length, 2, `expected 2 upstream requests, got ${upstream.requests.length}`);
      const [reqA, reqB] = upstream.requests.map((r) => r.body);

      const canonUpA = canonicalizeUpstream(reqA);
      const canonUpB = canonicalizeUpstream(reqB);

      // Cleanliness invariants (Antigravity-Manager alignment signals):
      // - no "[undefined]" strings
      // - no obviously-forbidden keys that commonly trigger 4xx schema enforcement
      // - must preserve v1internal wrapper fields
      for (const [label, raw] of [
        ['routecodex.upstream', reqA],
        ['rcc.upstream', reqB]
      ]) {
        assertNoUndefinedStrings(label, raw);
        assertNoForbiddenWrapperFields(label, raw);
        assert.equal(typeof raw?.project, 'string', `${label}: missing project`);
        assert.equal(typeof raw?.model, 'string', `${label}: missing model`);
        assert.equal(typeof raw?.requestId, 'string', `${label}: missing requestId`);
        assert.equal(typeof raw?.request, 'object', `${label}: missing request`);
      }

      const canonRespA = canonicalizeResponses(routecodex.response);
      const canonRespB = canonicalizeResponses(rcc.response);
      assert.deepEqual(
        canonRespA,
        canonRespB,
        `Client response mismatch (routecodex vs rcc).\nroutecodex=${JSON.stringify(canonRespA).slice(0, 2000)}\nrcc=${JSON.stringify(canonRespB).slice(0, 2000)}`
      );

      // Stronger semantic check: extracted text must match expected sentinel.
      assert.equal(extractTextFromResponses(routecodex.response), 'ok-from-mock');
      assert.equal(extractTextFromResponses(rcc.response), 'ok-from-mock');

      // Optional strict parity: upstream request must be equal after canonicalization.
      // Default off because tool registries can legitimately diverge between routecodex dev and rcc release.
      if (String(process.env.ROUTECODEX_BLACKBOX_STRICT || '').trim() === '1') {
        const upRoutecodexPath = path.join(tempDir, 'upstream.routecodex.json');
        const upRccPath = path.join(tempDir, 'upstream.rcc.json');
        fs.writeFileSync(upRoutecodexPath, `${JSON.stringify(reqA, null, 2)}\n`, 'utf8');
        fs.writeFileSync(upRccPath, `${JSON.stringify(reqB, null, 2)}\n`, 'utf8');
        assert.deepEqual(
          canonUpA,
          canonUpB,
          `Upstream request mismatch (routecodex vs rcc). Captures: ${upRoutecodexPath} ${upRccPath}`
        );
      } else if (JSON.stringify(canonUpA) !== JSON.stringify(canonUpB)) {
        const upRoutecodexPath = path.join(tempDir, 'upstream.routecodex.json');
        const upRccPath = path.join(tempDir, 'upstream.rcc.json');
        fs.writeFileSync(upRoutecodexPath, `${JSON.stringify(reqA, null, 2)}\n`, 'utf8');
        fs.writeFileSync(upRccPath, `${JSON.stringify(reqB, null, 2)}\n`, 'utf8');
        console.warn(
          `⚠️ upstream request differs (routecodex vs rcc); captures written: ${upRoutecodexPath} ${upRccPath}`
        );
      }

      console.log('✅ blackbox ok: routecodex == rcc (client response parity; upstream cleanliness OK)');
    } finally {
      await upstream.close();
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

main().catch((err) => {
  console.error('❌ blackbox parity failed:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
