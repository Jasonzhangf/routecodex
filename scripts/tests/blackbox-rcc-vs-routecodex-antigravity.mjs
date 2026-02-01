#!/usr/bin/env node
/**
 * Black-box parity test:
 * - Always validate RouteCodex behavior against Antigravity-Manager invariants.
 * - Optionally compare against rcc release (off by default) because rcc bundles a published @jsonstudio/llms
 *   which may intentionally lag behind dev during incident response.
 * - Both point to a local mock Cloud Code Assist (v1internal) upstream.
 * - Assert:
 *   - RouteCodex upstream requests are "clean" and match Antigravity-Manager signature semantics
 *   - (optional) client-visible responses are equivalent across RouteCodex and rcc
 *
 * This catches "dirty request" regressions and CLI divergence early.
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK_THOUGHT_SIGNATURE = `tsig-${'x'.repeat(80)}`; // >= 50 chars (Antigravity cache requires min length)

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
  const carrier =
    top.request && typeof top.request === 'object' && !Array.isArray(top.request)
      ? top
      : top.data && typeof top.data === 'object' && !Array.isArray(top.data) && top.data.request && typeof top.data.request === 'object'
        ? top.data
        : top;
  const inner =
    carrier.request && typeof carrier.request === 'object' && !Array.isArray(carrier.request) ? carrier.request : {};

  for (const key of ['metadata', 'web_search', 'messages', 'stream', 'sessionId', 'action']) {
    assert.equal(Object.prototype.hasOwnProperty.call(top, key), false, `${label}: forbidden top-level ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(inner, key), false, `${label}: forbidden request.${key}`);
  }
}

function getFirstUserTextFromGeminiRequest(raw) {
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const carrier =
    top.request && typeof top.request === 'object' && !Array.isArray(top.request)
      ? top
      : top.data && typeof top.data === 'object' && !Array.isArray(top.data) && top.data.request && typeof top.data.request === 'object'
        ? top.data
        : top;
  const requestNode =
    carrier.request && typeof carrier.request === 'object' && !Array.isArray(carrier.request) ? carrier.request : {};
  const contents = Array.isArray(requestNode.contents) ? requestNode.contents : [];
  for (const content of contents) {
    if (!content || typeof content !== 'object') continue;
    if (content.role !== 'user') continue;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const texts = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text.trim());
    }
    const combined = texts.join(' ').trim();
    if (combined) return combined;
  }
  return '';
}

function extractThoughtSignaturesFromGeminiRequest(raw) {
  const hits = [];
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const carrier =
    top.request && typeof top.request === 'object' && !Array.isArray(top.request)
      ? top
      : top.data && typeof top.data === 'object' && !Array.isArray(top.data) && top.data.request && typeof top.data.request === 'object'
        ? top.data
        : top;
  const requestNode =
    carrier.request && typeof carrier.request === 'object' && !Array.isArray(carrier.request) ? carrier.request : {};
  const contents = Array.isArray(requestNode.contents) ? requestNode.contents : [];
  for (const content of contents) {
    if (!content || typeof content !== 'object') continue;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (!part.functionCall || typeof part.functionCall !== 'object') continue;
      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim()) {
        hits.push(part.thoughtSignature.trim());
      } else {
        hits.push('');
      }
    }
  }
  return hits;
}

function extractThoughtSignaturePresenceFromGeminiRequest(raw) {
  const hits = [];
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const carrier =
    top.request && typeof top.request === 'object' && !Array.isArray(top.request)
      ? top
      : top.data && typeof top.data === 'object' && !Array.isArray(top.data) && top.data.request && typeof top.data.request === 'object'
        ? top.data
        : top;
  const requestNode =
    carrier.request && typeof carrier.request === 'object' && !Array.isArray(carrier.request) ? carrier.request : {};
  const contents = Array.isArray(requestNode.contents) ? requestNode.contents : [];
  for (const content of contents) {
    if (!content || typeof content !== 'object') continue;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (!part.functionCall || typeof part.functionCall !== 'object') continue;
      hits.push(Object.prototype.hasOwnProperty.call(part, 'thoughtSignature'));
    }
  }
  return hits;
}

function safeWriteJson(filePath, value) {
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // ignore
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

function assertAntigravityUaFresh(label, requests) {
  // Only enforce this for routecodex dev. rcc release is pinned to a published stack and may lag.
  if (label !== 'routecodex') return;
  const req = Array.isArray(requests) ? requests.find((r) => String(r?.url || '').includes(':generateContent') || String(r?.url || '').includes(':streamGenerateContent')) : null;
  const ua = req?.headers?.['user-agent'];
  const uaString = typeof ua === 'string' ? ua : Array.isArray(ua) ? ua.join(' ') : '';
  assert.ok(uaString.toLowerCase().startsWith('antigravity/'), `${label}: upstream User-Agent must start with antigravity/ (got ${JSON.stringify(uaString)})`);
  assert.ok(!uaString.toLowerCase().includes('codex_cli_rs/'), `${label}: upstream User-Agent must not be codex_cli_rs (got ${JSON.stringify(uaString)})`);
  // RouteCodex must keep a stable per-alias fingerprint suffix derived from camoufox OAuth fingerprint.
  // (This blackbox provides a fake camoufox fingerprint for alias "test" and asserts it is honored.)
  assert.ok(
    /^antigravity\/\d+\.\d+\.\d+ windows\/amd64$/i.test(uaString.trim()),
    `${label}: UA must honor per-alias suffix windows/amd64 (got ${JSON.stringify(uaString)})`
  );
}

function writeCamoufoxFingerprintForAlias({ dir, provider, alias, platform, userAgent, oscpu }) {
  const providerFamily =
    String(provider || '').toLowerCase() === 'antigravity' || String(provider || '').toLowerCase() === 'gemini-cli'
      ? 'gemini'
      : String(provider || '').toLowerCase();
  const profileId = `rc-${providerFamily}.${String(alias || '').toLowerCase()}`;
  const fpDir = path.join(dir, '.routecodex', 'camoufox-fp');
  fs.mkdirSync(fpDir, { recursive: true });
  const fpPath = path.join(fpDir, `${profileId}.json`);
  const camouConfig = {
    'navigator.platform': platform,
    'navigator.userAgent': userAgent,
    'navigator.oscpu': oscpu
  };
  fs.writeFileSync(fpPath, JSON.stringify({ env: { CAMOU_CONFIG_1: JSON.stringify(camouConfig) } }, null, 2));
  return fpPath;
}

async function startMockUpstream() {
  const requests = [];
  let lastIssuedSignature = null;
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
      const firstUserText = getFirstUserTextFromGeminiRequest(parsed);
      const wantsSignaturePriming = firstUserText.includes('bb-prime-thought-signature');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

        if (wantsSignaturePriming) {
          lastIssuedSignature = MOCK_THOUGHT_SIGNATURE;
          const response = {
            response: {
              candidates: [
                {
                  index: 0,
                  finishReason: 'TOOL_CALLS',
                  content: {
                    role: 'model',
                    parts: [
                      {
                        thoughtSignature: MOCK_THOUGHT_SIGNATURE,
                        functionCall: {
                          name: 'exec_command',
                          args: { command: 'echo prime' }
                        }
                      }
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

        const response = {
          response: {
            candidates: [
              {
                index: 0,
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ text: 'ok-from-mock' }]
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
      const firstUserText = getFirstUserTextFromGeminiRequest(parsed);
      if (firstUserText.includes('bb-prime-thought-signature')) {
        lastIssuedSignature = MOCK_THOUGHT_SIGNATURE;
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      thoughtSignature: MOCK_THOUGHT_SIGNATURE,
                      functionCall: {
                        name: 'exec_command',
                        args: { command: 'echo prime' }
                      }
                    }
                  ]
                }
              }
            ]
          })
        );
        return;
      }
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok-from-mock' }] } }] }));
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
        return;
      }
      try {
        res.end();
      } catch {
        // ignore
      }
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
    getLastIssuedSignature: () => lastIssuedSignature,
    close: async () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function writeTempConfig({ dir, serverPort, upstreamBaseUrl, tokenFile, targetModel }) {
  const cfgPath = path.join(dir, `config-${serverPort}.json`);
  const modelName = String(targetModel || 'gemini-3-pro-high').trim() || 'gemini-3-pro-high';
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
          compatibilityProfile: 'chat:gemini-cli',
          baseURL: upstreamBaseUrl,
          auth: {
            type: 'antigravity-oauth',
            entries: [
              { alias: 'test', type: 'antigravity-oauth', tokenFile }
            ]
          },
          models: {
            [modelName]: { supportsStreaming: true }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default-primary',
            priority: 200,
            mode: 'priority',
            targets: [`antigravity.${modelName}`]
          }
        ],
        thinking: [
          {
            id: 'thinking-primary',
            priority: 200,
            mode: 'priority',
            targets: [`antigravity.${modelName}`]
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
    antigravityApiBase,
    sessionId: sessionIdOverride
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
    // Disable token daemon + OAuth auto-open to keep the blackbox test non-interactive.
    ROUTECODEX_DISABLE_TOKEN_DAEMON: '1',
    RCC_DISABLE_TOKEN_DAEMON: '1',
    ROUTECODEX_OAUTH_AUTO_OPEN: '0',
    // Keep blackbox deterministic/hermetic: do not hit Antigravity auto-updater from CI.
    ROUTECODEX_ANTIGRAVITY_UA_DISABLE_REMOTE: '1',
    RCC_ANTIGRAVITY_UA_DISABLE_REMOTE: '1',
    // Also pin UA version so we don't rely on hardcoded fallbacks in tests.
    ROUTECODEX_ANTIGRAVITY_UA_VERSION: '1.11.9',
    RCC_ANTIGRAVITY_UA_VERSION: '1.11.9',
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

    const sessionId = typeof sessionIdOverride === 'string' && sessionIdOverride.trim().length
      ? sessionIdOverride.trim()
      : `bb-antigravity-session-${Date.now()}`;

    // 1) /v1/responses smoke (existing parity baseline)
    const res = await withTimeout(
      fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': 'verify-key',
          'x-route-hint': 'thinking',
          'x-session-id': sessionId
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

    // 2) Cold followup: include assistant tool call history WITHOUT priming a signature first.
    // Antigravity-Manager does not invent dummy thoughtSignature fields for functionCall parts.
    const coldRes = await withTimeout(
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': 'verify-key',
          'x-route-hint': 'thinking',
          'x-session-id': sessionId
        },
        body: JSON.stringify({
          model: 'gpt-5.2-codex',
          stream: false,
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
          messages: [
            { role: 'user', content: 'bb-cold-followup: please call exec_command' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bb_cold_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: JSON.stringify({ cmd: 'echo cold' })
                  }
                }
              ]
            },
            { role: 'tool', tool_call_id: 'call_bb_cold_1', content: 'ok' },
            { role: 'user', content: 'bb-cold-followup: continue' }
          ]
        })
      }),
      25000,
      `${label}:/v1/chat/completions:cold`
    );
    const coldText = await coldRes.text();
    if (!coldRes.ok) {
      throw new Error(`${label} cold /v1/chat/completions HTTP ${coldRes.status}: ${coldText.slice(0, 300)}`);
    }

    // 3) Prime Antigravity thoughtSignature cache (mock returns a functionCall part with thoughtSignature)
    const primeRes = await withTimeout(
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': 'verify-key',
          'x-route-hint': 'thinking',
          'x-session-id': sessionId
        },
        body: JSON.stringify({
          model: 'gpt-5.2-codex',
          stream: false,
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
          messages: [
            { role: 'user', content: 'bb-prime-thought-signature: please call exec_command' }
          ]
        })
      }),
      25000,
      `${label}:/v1/chat/completions:prime`
    );
    const primeText = await primeRes.text();
    if (!primeRes.ok) {
      throw new Error(`${label} prime /v1/chat/completions HTTP ${primeRes.status}: ${primeText.slice(0, 300)}`);
    }

    // 4) Followup: include assistant tool call history (no thoughtSignature in OpenAI format).
    // llmswitch-core compat must inject the cached signature into Gemini functionCall parts.
    const followRes = await withTimeout(
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': 'verify-key',
          'x-route-hint': 'thinking',
          'x-session-id': sessionId
        },
        body: JSON.stringify({
          model: 'gpt-5.2-codex',
          stream: false,
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
          messages: [
            { role: 'user', content: 'bb-prime-thought-signature: please call exec_command' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bb_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: JSON.stringify({ cmd: 'echo followup' })
                  }
                }
              ]
            },
            { role: 'tool', tool_call_id: 'call_bb_1', content: 'ok' },
            { role: 'user', content: 'bb-verify-injection: continue' }
          ]
        })
      }),
      25000,
      `${label}:/v1/chat/completions:followup`
    );
    const followText = await followRes.text();
    if (!followRes.ok) {
      throw new Error(`${label} followup /v1/chat/completions HTTP ${followRes.status}: ${followText.slice(0, 300)}`);
    }

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
    const runRcc = String(process.env.ROUTECODEX_BLACKBOX_RUN_RCC || '').trim() === '1';

    const rccLlmsHasAntigravitySignatureCache = (() => {
      try {
        const candidate = path.join(
          process.cwd(),
          'node_modules/@jsonstudio/rcc/node_modules/@jsonstudio/llms/dist/conversion/compat/antigravity-session-signature.js'
        );
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    })();

    // Name includes "-static" so OAuth lifecycle (if invoked) will never try refresh/reauth in this blackbox test.
    const tokenFile = path.join(tempDir, 'antigravity-oauth-1-static.json');
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ access_token: 'test_access_token', token_type: 'Bearer', project_id: 'test-project' }, null, 2)
    );
    // Provide a deterministic camoufox fingerprint so UA suffix is selected per-alias (no machine drift).
    writeCamoufoxFingerprintForAlias({
      dir: tempDir,
      provider: 'antigravity',
      alias: 'test',
      platform: 'Win32',
      oscpu: 'Windows NT 10.0; Win64; x64',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    });

    const upstream = await startMockUpstream();
    try {
      // Run routecodex (dev) against the SAME upstream.
      const cfg1 = writeTempConfig({
        dir: tempDir,
        serverPort: 5591,
        upstreamBaseUrl: upstream.baseUrl,
        tokenFile,
        targetModel: 'gemini-3-pro-high'
      });
      const beforeA = upstream.requests.length;
      const routecodex = await runOnceBlackbox({
        label: 'routecodex',
        entryScript: 'dist/index.js',
        port: 5591,
        configPath: cfg1,
        homeDir: tempDir,
        sessionId: 'bb-antigravity-session-gemini',
        antigravityApiBase: upstream.baseUrl
      });
      const afterA = upstream.requests.length;
      const sliceA = upstream.requests.slice(beforeA, afterA);
      assertAntigravityUaFresh('routecodex', sliceA);
      assert.equal(extractTextFromResponses(routecodex.response), 'ok-from-mock');
      const genA = sliceA.filter((r) => {
        const u = String(r.url || '');
        return u.includes(':streamGenerateContent') || u.includes(':generateContent');
      });
      assert.ok(genA.length >= 4, `routecodex: expected >=4 content-generation calls, got ${genA.length}`);
      const coldReqA = genA[1]?.body;
      const followUpReqA = genA[genA.length - 1]?.body;
      assert.ok(coldReqA, 'routecodex: missing cold upstream request body');
      assert.ok(followUpReqA, 'routecodex: missing followup upstream request body');

      // Cold followup should not include dummy or any thoughtSignature keys.
      const coldSigsA = extractThoughtSignaturesFromGeminiRequest(coldReqA).filter((s) => s);
      assert.ok(
        coldSigsA.every((s) => s !== 'skip_thought_signature_validator'),
        `routecodex: cold followup must not send dummy thoughtSignature (got ${JSON.stringify(coldSigsA.slice(0, 10))})`
      );
      const coldPresenceA = extractThoughtSignaturePresenceFromGeminiRequest(coldReqA);
      if (coldPresenceA.some(Boolean)) {
        safeWriteJson(path.join(tempDir, 'upstream.routecodex.cold.json'), coldReqA);
        throw new Error(`routecodex: cold followup unexpectedly contains thoughtSignature keys (captures in ${tempDir})`);
      }

      const sigsA = extractThoughtSignaturesFromGeminiRequest(followUpReqA).filter((s) => s);
      const routecodexInjected = sigsA.includes(MOCK_THOUGHT_SIGNATURE);
      if (!routecodexInjected) {
        safeWriteJson(path.join(tempDir, 'upstream.routecodex.followup.json'), followUpReqA);
        safeWriteJson(path.join(tempDir, 'upstream.routecodex.prime.json'), genA[2]?.body || null);
        safeWriteJson(path.join(tempDir, 'debug.routecodex.signature.json'), {
          expected: MOCK_THOUGHT_SIGNATURE,
          got: sigsA,
          firstUserTextFollowup: getFirstUserTextFromGeminiRequest(followUpReqA),
          firstUserTextPrime: getFirstUserTextFromGeminiRequest(genA[2]?.body || null)
        });
      }

      assert.ok(
        routecodexInjected,
        `routecodex: thoughtSignature injection missing (captures in ${tempDir})`
      );

      // Cleanliness invariants (Antigravity-Manager alignment signals):
      const reqA = genA[0]?.body;
      assert.ok(reqA, 'routecodex: expected upstream request for /v1/responses baseline');

      const canonUpA = canonicalizeUpstream(reqA);

      {
        const label = 'routecodex.upstream';
        const raw = reqA;
        assertNoUndefinedStrings(label, raw);
        assertNoForbiddenWrapperFields(label, raw);
        assert.equal(typeof raw?.project, 'string', `${label}: missing project`);
        assert.equal(typeof raw?.model, 'string', `${label}: missing model`);
        assert.equal(typeof raw?.requestId, 'string', `${label}: missing requestId`);
        assert.equal(typeof raw?.request, 'object', `${label}: missing request`);
      }

      // Second pass: Claude model routed via Antigravity (same v1internal transport; different model family).
      upstream.requests.splice(0, upstream.requests.length);
      const cfgClaude = writeTempConfig({
        dir: tempDir,
        serverPort: 5593,
        upstreamBaseUrl: upstream.baseUrl,
        tokenFile,
        targetModel: 'claude-sonnet-4-5-thinking'
      });
      const beforeC = upstream.requests.length;
      const routecodexClaude = await runOnceBlackbox({
        label: 'routecodex',
        entryScript: 'dist/index.js',
        port: 5593,
        configPath: cfgClaude,
        homeDir: tempDir,
        sessionId: 'bb-antigravity-session-claude',
        antigravityApiBase: upstream.baseUrl
      });
      const afterC = upstream.requests.length;
      const sliceC = upstream.requests.slice(beforeC, afterC);
      assertAntigravityUaFresh('routecodex', sliceC);
      assert.equal(extractTextFromResponses(routecodexClaude.response), 'ok-from-mock');
      const genC = sliceC.filter((r) => {
        const u = String(r.url || '');
        return u.includes(':streamGenerateContent') || u.includes(':generateContent');
      });
      assert.ok(genC.length >= 4, `routecodex (claude): expected >=4 content-generation calls, got ${genC.length}`);
      const coldReqC = genC[1]?.body;
      const followUpReqC = genC[genC.length - 1]?.body;
      assert.ok(coldReqC, 'routecodex (claude): missing cold upstream request body');
      assert.ok(followUpReqC, 'routecodex (claude): missing followup upstream request body');

      const coldSigsC = extractThoughtSignaturesFromGeminiRequest(coldReqC).filter((s) => s);
      assert.ok(
        coldSigsC.every((s) => s !== 'skip_thought_signature_validator'),
        `routecodex (claude): cold followup must not send dummy thoughtSignature (got ${JSON.stringify(coldSigsC.slice(0, 10))})`
      );
      const coldPresenceC = extractThoughtSignaturePresenceFromGeminiRequest(coldReqC);
      if (coldPresenceC.some(Boolean)) {
        // New behavior (alias-scoped cache): if the previous run already primed a signature for this alias,
        // the cold followup may immediately reuse it (with sessionId rewind handled in provider/runtime).
        //
        // Keep this deterministic: when present, it must be the mock signature (never the dummy sentinel).
        const coldInjected = coldSigsC.includes(MOCK_THOUGHT_SIGNATURE);
        if (!coldInjected) {
          safeWriteJson(path.join(tempDir, 'upstream.routecodex.claude.cold.json'), coldReqC);
          safeWriteJson(path.join(tempDir, 'debug.routecodex.claude.cold-signature.json'), {
            expected: MOCK_THOUGHT_SIGNATURE,
            got: coldSigsC,
            firstUserText: getFirstUserTextFromGeminiRequest(coldReqC)
          });
        }
        assert.ok(
          coldInjected,
          `routecodex (claude): cold followup signature mismatch (captures in ${tempDir})`
        );
      }

      const sigsC = extractThoughtSignaturesFromGeminiRequest(followUpReqC).filter((s) => s);
      const routecodexClaudeInjected = sigsC.includes(MOCK_THOUGHT_SIGNATURE);
      if (!routecodexClaudeInjected) {
        safeWriteJson(path.join(tempDir, 'upstream.routecodex.claude.followup.json'), followUpReqC);
        safeWriteJson(path.join(tempDir, 'upstream.routecodex.claude.prime.json'), genC[2]?.body || null);
        safeWriteJson(path.join(tempDir, 'debug.routecodex.claude.signature.json'), {
          expected: MOCK_THOUGHT_SIGNATURE,
          got: sigsC,
          firstUserTextFollowup: getFirstUserTextFromGeminiRequest(followUpReqC),
          firstUserTextPrime: getFirstUserTextFromGeminiRequest(genC[2]?.body || null)
        });
      }
      assert.ok(
        routecodexClaudeInjected,
        `routecodex (claude): thoughtSignature injection missing (captures in ${tempDir})`
      );

      const reqC = genC[0]?.body;
      assert.ok(reqC, 'routecodex (claude): expected upstream request for /v1/responses baseline');
      assertNoUndefinedStrings('routecodex.upstream', reqC);
      assertNoForbiddenWrapperFields('routecodex.upstream', reqC);
      assert.equal(typeof reqC?.project, 'string', 'routecodex.upstream: missing project');
      assert.equal(typeof reqC?.model, 'string', 'routecodex.upstream: missing model');
      assert.equal(typeof reqC?.requestId, 'string', 'routecodex.upstream: missing requestId');
      assert.equal(typeof reqC?.request, 'object', 'routecodex.upstream: missing request');

      if (runRcc) {
        // Reset upstream capture for the next run (keep the same server instance).
        upstream.requests.splice(0, upstream.requests.length);

        const cfg2 = writeTempConfig({
          dir: tempDir,
          serverPort: 5592,
          upstreamBaseUrl: upstream.baseUrl,
          tokenFile,
          targetModel: 'gemini-3-pro-high'
        });
        const beforeB = upstream.requests.length;
        const rcc = await runOnceBlackbox({
          label: 'rcc',
          entryScript: 'node_modules/@jsonstudio/rcc/dist/index.js',
          port: 5592,
          configPath: cfg2,
          homeDir: tempDir,
          antigravityApiBase: upstream.baseUrl
        });
        const afterB = upstream.requests.length;
        const sliceB = upstream.requests.slice(beforeB, afterB);
        const genB = sliceB.filter((r) => {
          const u = String(r.url || '');
          return u.includes(':streamGenerateContent') || u.includes(':generateContent');
        });
        assert.ok(genB.length >= 4, `rcc: expected >=4 content-generation calls, got ${genB.length}`);
        const coldReqB = genB[1]?.body;
        const followUpReqB = genB[genB.length - 1]?.body;
        assert.ok(coldReqB, 'rcc: missing cold upstream request body');
        assert.ok(followUpReqB, 'rcc: missing followup upstream request body');

        // rcc cold followup signature semantics may lag; only assert if it has the cache implementation.
        if (rccLlmsHasAntigravitySignatureCache) {
          const coldSigsB = extractThoughtSignaturesFromGeminiRequest(coldReqB).filter((s) => s);
          assert.ok(
            coldSigsB.every((s) => s !== 'skip_thought_signature_validator'),
            `rcc: cold followup must not send dummy thoughtSignature (got ${JSON.stringify(coldSigsB.slice(0, 10))})`
          );
          const coldPresenceB = extractThoughtSignaturePresenceFromGeminiRequest(coldReqB);
          if (coldPresenceB.some(Boolean)) {
            // When the alias-scoped cache is already populated (e.g. by the routecodex run above),
            // the cold followup may immediately reuse the cached signature.
            const coldInjected = coldSigsB.includes(MOCK_THOUGHT_SIGNATURE);
            if (!coldInjected) {
              safeWriteJson(path.join(tempDir, 'upstream.rcc.cold.json'), coldReqB);
              safeWriteJson(path.join(tempDir, 'debug.rcc.cold-signature.json'), {
                expected: MOCK_THOUGHT_SIGNATURE,
                got: coldSigsB,
                firstUserText: getFirstUserTextFromGeminiRequest(coldReqB)
              });
            }
            assert.ok(
              coldInjected,
              `rcc: cold followup signature mismatch (captures in ${tempDir})`
            );
          }
        }

        const sigsB = extractThoughtSignaturesFromGeminiRequest(followUpReqB).filter((s) => s);
        const rccInjected = sigsB.includes(MOCK_THOUGHT_SIGNATURE);
        if (rccLlmsHasAntigravitySignatureCache) {
          assert.ok(rccInjected, `rcc: thoughtSignature injection missing (captures in ${tempDir})`);
        }

        const canonRespA = canonicalizeResponses(routecodex.response);
        const canonRespB = canonicalizeResponses(rcc.response);
        assert.deepEqual(
          canonRespA,
          canonRespB,
          `Client response mismatch (routecodex vs rcc).\nroutecodex=${JSON.stringify(canonRespA).slice(0, 2000)}\nrcc=${JSON.stringify(canonRespB).slice(0, 2000)}`
        );

        const reqB = genB[0]?.body;
        assert.ok(reqB, 'rcc: expected upstream request for /v1/responses baseline');
        const canonUpB = canonicalizeUpstream(reqB);

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
        } else if (
          String(process.env.ROUTECODEX_BLACKBOX_KEEP || '').trim() === '1' &&
          JSON.stringify(canonUpA) !== JSON.stringify(canonUpB)
        ) {
          const upRoutecodexPath = path.join(tempDir, 'upstream.routecodex.json');
          const upRccPath = path.join(tempDir, 'upstream.rcc.json');
          fs.writeFileSync(upRoutecodexPath, `${JSON.stringify(reqA, null, 2)}\n`, 'utf8');
          fs.writeFileSync(upRccPath, `${JSON.stringify(reqB, null, 2)}\n`, 'utf8');
          console.warn(
            `⚠️ upstream request differs (routecodex vs rcc); captures written: ${upRoutecodexPath} ${upRccPath}`
          );
        } else if (JSON.stringify(canonUpA) !== JSON.stringify(canonUpB)) {
          console.warn('⚠️ upstream request differs (routecodex vs rcc); set ROUTECODEX_BLACKBOX_KEEP=1 to write captures');
        }

        console.log('✅ blackbox ok: routecodex (Antigravity invariants) + rcc response parity');
      } else {
        void canonUpA;
        console.log('✅ blackbox ok: routecodex (Antigravity-Manager invariants)');
      }
    } finally {
      await upstream.close();
    }
  } finally {
    try {
      const keep = String(process.env.ROUTECODEX_BLACKBOX_KEEP || '').trim() === '1';
      if (keep) {
        console.log(`🧾 blackbox artifacts kept: ${tempDir}`);
      } else {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failure
    }
  }
}

main().catch((err) => {
  console.error('❌ blackbox parity failed:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
