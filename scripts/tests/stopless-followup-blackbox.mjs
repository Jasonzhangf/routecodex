#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { MetadataCenter } from '../../dist/server/runtime/http-server/metadata-center/metadata-center.js';

const REAL_CODEX_REQUEST_FIXTURE = path.resolve(
  'tests/fixtures/errorsamples/responses-request-standardization/2026-06-13-duplicate-replay-wrapper-noise/request-body.json'
);

function setEnv(name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return () => {
    if (old === undefined) delete process.env[name]; else process.env[name] = old;
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return { server, baseUrl: `http://127.0.0.1:${a.port}` };
}

async function close(server) {
  if (!server) return;
  await new Promise((r) => server.close(() => r()));
}

async function writeProviderConfigs(userConfig) {
  const providerRoot = path.join(process.env.RCC_HOME || path.join(process.env.HOME, '.rcc'), 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, providerConfig] of Object.entries(userConfig.virtualrouter.providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({ version: '2.0.0', providerId, provider: providerConfig }, null, 2)}\n`,
      'utf8'
    );
  }
}

function makeProvider(id, upstreamBase) {
  return {
    id,
    providerType: 'responses',
    type: 'responses',
    endpoint: upstreamBase,
    auth: { type: 'apikey', apiKey: `${id}-`.padEnd(24, 'x') },
    models: { 'gpt-5.3-codex': {} }
  };
}

const STOPLESS_HARNESS_ROUTE_CONTROL = {
  providerProtocol: 'openai-responses',
  preselectedRoute: {
    target: {
      providerKey: 'crs1.key1',
      runtimeKey: 'crs1.key1',
      modelId: 'gpt-5.3-codex',
      outboundProfile: 'openai-responses',
      providerType: 'responses'
    },
    decision: { routeName: 'thinking' },
    diagnostics: {}
  }
};

function withStoplessHarnessRouteControl(input) {
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const center = MetadataCenter.read(metadata) ?? MetadataCenter.attach(metadata);
  center.writeRuntimeControl('providerProtocol', STOPLESS_HARNESS_ROUTE_CONTROL.providerProtocol, {
    module: 'scripts/tests/stopless-followup-blackbox.mjs',
    symbol: 'withStoplessHarnessRouteControl',
    stage: 'test'
  }, 'stopless followup blackbox provider protocol truth');
  center.writeRuntimeControl('preselectedRoute', STOPLESS_HARNESS_ROUTE_CONTROL.preselectedRoute, {
    module: 'scripts/tests/stopless-followup-blackbox.mjs',
    symbol: 'withStoplessHarnessRouteControl',
    stage: 'test'
  }, 'stopless followup blackbox preselected route');
  return {
    ...input,
    metadata
  };
}

function buildConfig(upstreamBase) {
  const routing = {
    thinking: [{ id: 'thinking', priority: 100, mode: 'round-robin', targets: ['crs1.gpt-5.3-codex', 'crs2.gpt-5.3-codex'] }],
    default: [{ id: 'default', priority: 10, mode: 'round-robin', targets: ['crs1.gpt-5.3-codex', 'crs2.gpt-5.3-codex'] }]
  };
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [{
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'relay'
      }]
    },
    virtualrouter: {
      routingPolicyGroups: { gateway_priority_5555: { routing } },
      providers: {
        crs1: makeProvider('crs1', upstreamBase),
        crs2: makeProvider('crs2', upstreamBase)
      },
      routing,
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

function upstreamResponse(text, finish = 'stop') {
  return {
    id: `resp_${Date.now()}`,
    object: 'response',
    status: 'completed',
    model: 'gpt-5.3-codex',
    output: [{
      id: `msg_${Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }],
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: finish
  };
}

function findExecCommandTool(body) {
  const candidates = [];
  const requiredActionCalls = body?.required_action?.submit_tool_outputs?.tool_calls;
  if (Array.isArray(requiredActionCalls)) {
    candidates.push(...requiredActionCalls);
  }
  const outputItems = Array.isArray(body?.output) ? body.output : [];
  if (outputItems.length > 0) {
    candidates.push(...outputItems);
  }
  for (const call of candidates) {
    const name = call?.name ?? call?.function?.name ?? null;
    if (name !== 'exec_command') continue;
    const raw = call?.function?.arguments ?? call?.arguments ?? '';
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.cmd === 'string') {
        return {
          callId: call.tool_call_id || call.id || call.call_id,
          command: parsed.cmd
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function isExplicitServerFollowup(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }
  if (String(body?.metadata?.__rt?.serverToolFollowup || '') === 'true') {
    return true;
  }
  const requestId = String(body?.request_id || '');
  const previousResponseId = String(body?.previous_response_id || '');
  return requestId.includes(':stop_followup') || previousResponseId.includes(':stop_followup');
}

function parseSseResponseEnvelope(text) {
  const response = {};
  let lastPayload = null;
  const blocks = String(text || '').split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    let event = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    lastPayload = payload;
    if (payload && typeof payload === 'object') {
      const candidate = payload.response && typeof payload.response === 'object'
        ? payload.response
        : payload;
      if (
        event === 'response.completed'
        || event === 'response.done'
        || event === 'response.required_action'
        || candidate?.object === 'response'
        || candidate?.required_action
      ) {
        Object.assign(response, candidate);
      }
    }
  }
  if (Object.keys(response).length > 0) {
    materializeResponsesOutputText(response);
    return response;
  }
  if (lastPayload && typeof lastPayload === 'object') {
    const fallback = lastPayload.response && typeof lastPayload.response === 'object'
      ? lastPayload.response
      : lastPayload;
    materializeResponsesOutputText(fallback);
    return fallback;
  }
  throw new Error(`Unable to materialize SSE response envelope: ${text.slice(0, 500)}`);
}

function materializeResponsesOutputText(response) {
  if (!response || typeof response !== 'object' || typeof response.output_text === 'string') {
    return;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  if (parts.length > 0) {
    response.output_text = parts.join('');
  }
}

function parseJsonOrSseResponse(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return parseSseResponseEnvelope(trimmed);
}

function runCliCommand(command) {
  const result = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`CLI failed: ${result.stderr || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

async function buildRealCodexResponsesRequest(sessionId) {
  const raw = await fs.readFile(REAL_CODEX_REQUEST_FIXTURE, 'utf8');
  const payload = JSON.parse(raw);
  const next = JSON.parse(JSON.stringify(payload));
  next.model = 'gpt-5.3-codex';
  next.stream = false;
  next.metadata = {
    ...(next.metadata && typeof next.metadata === 'object' ? next.metadata : {}),
    sessionId,
    conversationId: sessionId
  };
  return next;
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopless-blackbox-'));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  const sessionId = `stopless-relay-${Date.now()}`;
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '1'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '2')
  ];

  let upstreamServer;
  let harnessServer;
  let upstreamHits = [];

  try {
    const upstreamApp = express();
    upstreamApp.use(express.json({ limit: '2mb' }));
    upstreamApp.use((req, _res, next) => {
      console.error('[stopless-followup-blackbox] upstream request', req.method, req.path);
      next();
    });
    upstreamApp.all('*', (req, res) => {
      upstreamHits.push(req.body);
      if (String(req.path).includes('/models')) {
        return res.json({ data: [{ id: 'gpt-5.3-codex' }] });
      }
      const isFollowup = isExplicitServerFollowup(req.body);
      const authHeader = req.get('authorization') || '';
      const providerFromAuth = authHeader.includes('crs1-') ? 'crs1' : authHeader.includes('crs2-') ? 'crs2' : 'unknown';
      upstreamHits[upstreamHits.length - 1].providerFromAuth = providerFromAuth;
      upstreamHits[upstreamHits.length - 1].isFollowup = isFollowup;
      // The first response deliberately ends with stop to trigger stopless CLI projection.
      if (upstreamHits.length === 1) {
        return res.json(upstreamResponse('阶段完成', 'stop'));
      }
      return res.json(upstreamResponse('继续执行中', 'stop'));
    });
    upstreamServer = await listen(http.createServer(upstreamApp));

    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');

    const routeCodex = new RouteCodexHttpServer({
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    });

    routeCodex.managerDaemon = {
      getModule(id) {
        if (id !== 'quota') return undefined;
        return {
          registerProviderStaticConfig: () => {},
          getQuotaView: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }),
          getQuotaViewReadOnly: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 })
        };
      }
    };

    const userConfig = buildConfig(upstreamServer.baseUrl);
    await writeProviderConfigs(userConfig);
    await routeCodex.initializeWithUserConfig(userConfig);

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, withStoplessHarnessRouteControl(input)),
      errorHandling: routeCodex.errorHandling
    }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, withStoplessHarnessRouteControl(input)),
      errorHandling: routeCodex.errorHandling
    }, {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      responseIdFromPath: req.params?.id
    }));
    harnessServer = await listen(http.createServer(app));

    const firstPayload = await buildRealCodexResponsesRequest(sessionId);
    const resp = await fetch(`${harnessServer.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify(firstPayload)
    });

    const text = await resp.text();
    assert.equal(resp.status, 200, `expected 200, got ${resp.status}, body=${text}`);
    const body = JSON.parse(text);
    const execTool = findExecCommandTool(body);
    assert.ok(execTool, `expected exec_command projection, body=${text}`);
    const command = execTool.command;
    const args = JSON.parse(command.match(/--input-json '([^']+)'(?=\s--|$)/)?.[1] || '{}');
    assert.ok(
      command.includes('routecodex hook run reasoningStop'),
      `expected reasoningStop CLI projection, args=${command}`
    );
    assert.match(command, /--session-id '[^']+'/u, `expected request-truth session id in command, args=${command}`);
    assert.match(command, /--request-id '[^']+'/u, `expected request-truth request id in command, args=${command}`);
    assert.ok(
      !String(command).includes('continuationPrompt') && !String(command).includes('stopreason'),
      `expected status-only CLI input without leaked guidance, args=${command}`
    );
    assert.equal(upstreamHits.length, 1, `expected exactly one upstream hit before client-side CLI execution, got ${upstreamHits.length}`);
    assert.equal(upstreamHits[0]?.isFollowup, false, `unexpected server-side followup upstream hit: ${JSON.stringify(upstreamHits)}`);
    assert.equal(upstreamHits[0]?.providerFromAuth, 'crs1', `initial request should use first round-robin provider, hits=${JSON.stringify(upstreamHits)}`);

    const cliOutput1 = runCliCommand(command);
    assert.equal(cliOutput1.sessionId, sessionId, `expected CLI sessionId to round-trip, stdout=${JSON.stringify(cliOutput1)}`);
    assert.equal(cliOutput1.requestId, body.request_id || body.id || execTool.callId, `expected CLI requestId to round-trip, stdout=${JSON.stringify(cliOutput1)}`);

    const submit1 = await fetch(`${harnessServer.baseUrl}/v1/responses/${encodeURIComponent(body.id)}/submit_tool_outputs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify({
        tool_outputs: [
          {
            tool_call_id: execTool.callId,
            output: JSON.stringify(cliOutput1)
          }
        ]
      })
    });
    const submitText1 = await submit1.text();
    assert.equal(submit1.status, 200, `expected first submit_tool_outputs to succeed, body=${submitText1}`);
    const submitBody1 = parseJsonOrSseResponse(submitText1);
    const execTool2 = findExecCommandTool(submitBody1);
    assert.ok(execTool2, `expected second-round exec_command projection, body=${submitText1}`);
    const submitInput2 = JSON.parse(execTool2.command.match(/--input-json '([^']+)'(?=\s--|$)/)?.[1] || '{}');
    assert.equal(submitInput2.repeatCount, 2, `expected repeatCount=2 after first submit, body=${submitText1}`);

    const cliOutput2 = runCliCommand(execTool2.command);
    const submit2 = await fetch(`${harnessServer.baseUrl}/v1/responses/${encodeURIComponent(submitBody1.id)}/submit_tool_outputs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify({
        tool_outputs: [
          {
            tool_call_id: execTool2.callId,
            output: JSON.stringify(cliOutput2)
          }
        ]
      })
    });
    const submitText2 = await submit2.text();
    assert.equal(submit2.status, 200, `expected second submit_tool_outputs to succeed, body=${submitText2}`);
    const submitBody2 = parseJsonOrSseResponse(submitText2);
    const execTool3 = findExecCommandTool(submitBody2);
    assert.ok(!execTool3, `expected terminal stopless result after third round, body=${submitText2}`);
    assert.ok(
      typeof submitBody2?.output_text === 'string'
        && submitBody2.output_text.includes('继续执行中')
        && !submitBody2.output_text.includes('stopless budget exhausted'),
      `expected terminal stopless body to preserve original visible text without internal budget text, body=${submitText2}`
    );

    console.log('✅ stopless blackbox passed', JSON.stringify({
      upstreamHits: upstreamHits.length,
      providers: upstreamHits.map((hit) => hit.providerFromAuth),
      sessionId,
      execCommand: command,
      repeatCount2: submitInput2.repeatCount,
      status: resp.status
    }));
  } finally {
    await close(harnessServer?.server);
    await close(upstreamServer?.server);
    for (const r of restores.reverse()) r();
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((err) => {
  console.error('❌ stopless blackbox failed');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
