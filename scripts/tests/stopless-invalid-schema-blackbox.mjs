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
    decision: { routeName: 'thinking', providerProtocol: 'openai-responses' },
    diagnostics: {}
  }
};

function withStoplessHarnessRouteControl(input) {
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const center = MetadataCenter.read(metadata) ?? MetadataCenter.attach(metadata);
  center.writeRuntimeControl('providerProtocol', STOPLESS_HARNESS_ROUTE_CONTROL.providerProtocol, {
    module: 'scripts/tests/stopless-invalid-schema-blackbox.mjs',
    symbol: 'withStoplessHarnessRouteControl',
    stage: 'test'
  }, 'stopless invalid-schema blackbox provider protocol truth');
  center.writeRuntimeControl('preselectedRoute', STOPLESS_HARNESS_ROUTE_CONTROL.preselectedRoute, {
    module: 'scripts/tests/stopless-invalid-schema-blackbox.mjs',
    symbol: 'withStoplessHarnessRouteControl',
    stage: 'test'
  }, 'stopless invalid-schema blackbox preselected route');
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

function validTerminalSchemaText() {
  const schema = JSON.stringify({
    stopreason: 0,
    reason: '已完成 invalid schema 缺失字段反馈闭环',
    has_evidence: 1,
    evidence: 'provider request carried full missingFields feedback twice',
    issue_cause: '之前 schema 字段缺失',
    excluded_factors: '已排除 raw reasoningStop 泄漏和 endless CLI loop',
    diagnostic_order: 'first invalid -> full missingFields feedback -> second invalid -> next_step feedback -> terminal schema',
    done_steps: '完成两轮 invalid schema 修复反馈验证',
    next_step: '',
    next_suggested_path: '无',
    needs_user_input: false,
    learned: 'invalid schema feedback must enumerate every missing field until complete'
  });
  return `<rcc_stop_schema>${schema}</rcc_stop_schema>`;
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

function quotePosixSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function extractInputJson(command) {
  const match = String(command).match(/--input-json '([^']+)'(?=\s--|$)/u);
  return JSON.parse(match?.[1] ?? '{}');
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

function buildReasoningStopCommand(schema, projectionInput, sessionId, requestId) {
  const payload = {
    ...(typeof projectionInput.flowId === 'string' ? { flowId: projectionInput.flowId } : {}),
    ...(typeof projectionInput.repeatCount === 'number' ? { repeatCount: projectionInput.repeatCount } : {}),
    ...(typeof projectionInput.maxRepeats === 'number' ? { maxRepeats: projectionInput.maxRepeats } : {}),
    ...schema
  };
  return [
    'routecodex hook run reasoningStop',
    `--input-json ${quotePosixSingle(JSON.stringify(payload))}`,
    `--session-id ${quotePosixSingle(sessionId)}`,
    `--request-id ${quotePosixSingle(requestId)}`
  ].join(' ');
}

function assertExactSet(actual, expected, label) {
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${label}: expected exact missingFields ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function assertProviderFeedback(body, reasonCode, missingFields, label) {
  const text = JSON.stringify(body);
  assert.ok(text.includes(reasonCode), `${label}: provider request missing reasonCode=${reasonCode}: ${text}`);
  for (const field of missingFields) {
    assert.ok(text.includes(field), `${label}: provider request missing field=${field}: ${text}`);
  }
  assert.ok(
    text.includes(`missingFields=${missingFields.join(', ')}`) || missingFields.every((field) => text.includes(field)),
    `${label}: provider request must render missingFields: ${text}`
  );
}

function assertProviderGuidance(body, reasonCode, missingFields, label) {
  assertProviderFeedback(body, reasonCode, missingFields, label);
  const text = JSON.stringify(body);
  assert.ok(
    text.includes('上一轮执行结果') && text.includes(`reasonCode=${reasonCode}`),
    `${label}: provider request must include the prior round result snapshot: ${text}`
  );
  assert.ok(
    text.includes(`missingFields=${missingFields.join(', ')}`),
    `${label}: provider request must render exact missingFields order for the model: ${text}`
  );
  assert.ok(
    text.includes('任务还没完成，但当前没有明确 next_step')
      && text.includes('把下一步写成这轮立刻执行的最小动作'),
    `${label}: provider request must include next_step repair guidance: ${text}`
  );
  assert.ok(
    text.includes('按条件补齐这些字段') || text.includes('按字段之间的逻辑关系填写'),
    `${label}: provider request must explain conditional schema fields: ${text}`
  );
  assert.ok(
    text.includes('has_evidence=1 时 evidence 必须写证据')
      || text.includes('stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空'),
    `${label}: provider request must include has_evidence/evidence relation: ${text}`
  );
  assert.ok(
    text.includes('stopreason=2 必须写 next_step'),
    `${label}: provider request must include stopreason=2 relation: ${text}`
  );
  assert.ok(
    text.includes('needs_user_input=true 时 next_step 必须直接写要问用户的问题'),
    `${label}: provider request must include user-decision relation: ${text}`
  );
  assert.ok(
    text.includes('最小可复制样本')
      && text.includes('next_step')
      && text.includes('needs_user_input')
      && text.includes('has_evidence'),
    `${label}: provider request must include a complete minimal sample: ${text}`
  );
  assert.ok(
    !text.includes('每个字段都要写具体内容') && !text.includes('样例：'),
    `${label}: provider request must not regress to old all-fields/sample wording: ${text}`
  );
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopless-invalid-schema-'));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  const sessionId = `stopless-invalid-schema-${Date.now()}`;
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
  const upstreamHits = [];

  try {
    const upstreamApp = express();
    upstreamApp.use(express.json({ limit: '2mb' }));
    upstreamApp.use((req, _res, next) => {
      console.error('[stopless-invalid-schema-blackbox] upstream request', req.method, req.path);
      next();
    });
    upstreamApp.all('*', (req, res) => {
      upstreamHits.push(req.body);
      if (String(req.path).includes('/models')) {
        return res.json({ data: [{ id: 'gpt-5.3-codex' }] });
      }
      const authHeader = req.get('authorization') || '';
      upstreamHits[upstreamHits.length - 1].providerFromAuth = authHeader.includes('crs1-') ? 'crs1' : authHeader.includes('crs2-') ? 'crs2' : 'unknown';
      upstreamHits[upstreamHits.length - 1].isFollowup = isExplicitServerFollowup(req.body);
      if (upstreamHits.length === 1) {
        return res.json(upstreamResponse('第一轮 plain stop，触发 stopless CLI', 'stop'));
      }
      if (upstreamHits.length === 2) {
        return res.json(upstreamResponse('第二轮仍然 plain stop，等待第二次 invalid schema 修复', 'stop'));
      }
      return res.json(upstreamResponse(validTerminalSchemaText(), 'stop'));
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
    assert.equal(resp.status, 200, `expected first response 200, body=${text}`);
    const body = JSON.parse(text);
    const execTool1 = findExecCommandTool(body);
    assert.ok(execTool1, `expected first exec_command projection, body=${text}`);
    assert.equal(upstreamHits.length, 1, `expected one upstream hit before CLI execution, got ${upstreamHits.length}`);
    assert.equal(upstreamHits[0]?.isFollowup, false, `unexpected server-side followup hit: ${JSON.stringify(upstreamHits)}`);

    const firstProjectionInput = extractInputJson(execTool1.command);
    assert.equal(firstProjectionInput.repeatCount, 1, `expected first repeatCount=1, command=${execTool1.command}`);
    const missingRound1 = ['next_step'];
    const cliOutput1 = runCliCommand(buildReasoningStopCommand({
      stopreason: 2,
      reason: '还没完成'
    }, firstProjectionInput, sessionId, body.request_id || body.id || execTool1.callId));
    assert.equal(cliOutput1.input?.triggerHint, 'invalid_schema', `round1 CLI must mark invalid_schema: ${JSON.stringify(cliOutput1)}`);
    assert.equal(cliOutput1.schemaFeedback?.reasonCode, 'stop_schema_next_step_missing', `round1 CLI reason mismatch: ${JSON.stringify(cliOutput1)}`);
    assertExactSet(cliOutput1.schemaFeedback?.missingFields || [], missingRound1, 'round1 CLI feedback');
    assert.ok(!cliOutput1.schemaGuidance, `invalid schema CLI stdout must stay status-only: ${JSON.stringify(cliOutput1)}`);

    const submit1 = await fetch(`${harnessServer.baseUrl}/v1/responses/${encodeURIComponent(body.id)}/submit_tool_outputs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify({
        tool_outputs: [{
          tool_call_id: execTool1.callId,
          output: JSON.stringify(cliOutput1)
        }]
      })
    });
    const submitText1 = await submit1.text();
    assert.equal(submit1.status, 200, `expected first submit 200, body=${submitText1}`);
    assert.equal(upstreamHits.length, 2, `expected second upstream hit after first invalid submit, hits=${JSON.stringify(upstreamHits)}`);
    assertProviderGuidance(upstreamHits[1], 'stop_schema_next_step_missing', missingRound1, 'round1 provider guidance');
    assert.ok(!submitText1.includes('"reasoningStop"'), `client response leaked raw reasoningStop: ${submitText1}`);

    const submitBody1 = parseJsonOrSseResponse(submitText1);
    const execTool2 = findExecCommandTool(submitBody1);
    assert.ok(execTool2, `expected second exec_command projection, body=${submitText1}`);
    const secondProjectionInput = extractInputJson(execTool2.command);
    assert.equal(secondProjectionInput.repeatCount, 2, `expected second repeatCount=2, command=${execTool2.command}`);

    const missingRound2 = ['next_step'];
    const cliOutput2 = runCliCommand(buildReasoningStopCommand({
      stopreason: 2,
      reason: '只剩下一步字段未补齐',
      has_evidence: 1,
      evidence: 'round1 provider request already carried all missing fields',
      issue_cause: 'schema 仍缺 next_step',
      excluded_factors: '其它 required fields 已补齐',
      diagnostic_order: '补齐除 next_step 外的字段后再次验证',
      done_steps: '已补齐 evidence/done_steps/issue_cause/excluded_factors/diagnostic_order/next_suggested_path',
      next_suggested_path: '补 next_step 后完成',
      needs_user_input: false,
      learned: 'missingFields should shrink as fields are filled'
    }, secondProjectionInput, sessionId, submitBody1.request_id || submitBody1.id || execTool2.callId));
    assert.equal(cliOutput2.input?.triggerHint, 'invalid_schema', `round2 CLI must mark invalid_schema: ${JSON.stringify(cliOutput2)}`);
    assert.equal(cliOutput2.schemaFeedback?.reasonCode, 'stop_schema_next_step_missing', `round2 CLI reason mismatch: ${JSON.stringify(cliOutput2)}`);
    assertExactSet(cliOutput2.schemaFeedback?.missingFields || [], missingRound2, 'round2 CLI feedback');
    assert.ok(!cliOutput2.schemaGuidance, `invalid schema CLI stdout must stay status-only: ${JSON.stringify(cliOutput2)}`);

    const submit2 = await fetch(`${harnessServer.baseUrl}/v1/responses/${encodeURIComponent(submitBody1.id)}/submit_tool_outputs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify({
        tool_outputs: [{
          tool_call_id: execTool2.callId,
          output: JSON.stringify(cliOutput2)
        }]
      })
    });
    const submitText2 = await submit2.text();
    assert.equal(submit2.status, 200, `expected second submit 200, body=${submitText2}`);
    assert.equal(upstreamHits.length, 3, `expected third upstream hit after second invalid submit, hits=${JSON.stringify(upstreamHits)}`);
    assertProviderGuidance(upstreamHits[2], 'stop_schema_next_step_missing', missingRound2, 'round2 provider guidance');
    assert.ok(!submitText2.includes('"reasoningStop"'), `terminal client response leaked raw reasoningStop: ${submitText2}`);

    const submitBody2 = parseJsonOrSseResponse(submitText2);
    assert.ok(!findExecCommandTool(submitBody2), `complete schema must terminate without another CLI projection, body=${submitText2}`);
    assert.ok(
      typeof submitBody2?.output_text === 'string'
        && submitBody2.output_text.includes('已完成 invalid schema 缺失字段反馈闭环'),
      `terminal response must surface completed schema summary, body=${submitText2}`
    );
    assert.ok(
      !String(submitBody2?.output_text || '').includes('stopless budget exhausted'),
      `complete schema must not be misclassified as budget exhausted, body=${submitText2}`
    );

    console.log('✅ stopless invalid schema blackbox passed', JSON.stringify({
      upstreamHits: upstreamHits.length,
      providers: upstreamHits.map((hit) => hit.providerFromAuth),
      sessionId,
      round1MissingFields: cliOutput1.schemaFeedback.missingFields,
      round2MissingFields: cliOutput2.schemaFeedback.missingFields,
      terminal: submitBody2.output_text
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
  console.error('❌ stopless invalid schema blackbox failed');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
