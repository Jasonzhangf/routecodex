#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { MetadataCenter } from '../../dist/server/runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../../dist/server/runtime/http-server/metadata-center/dualwrite-api.js';

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
  MetadataCenter.attach(metadata);
  writeMetadataCenterSlot({
    target: metadata,
    family: 'runtime_control',
    key: 'providerProtocol',
    value: STOPLESS_HARNESS_ROUTE_CONTROL.providerProtocol,
    writer: {
      module: 'scripts/tests/stopless-contract-blackbox.mjs',
      symbol: 'withStoplessHarnessRouteControl',
      stage: 'test'
    },
    reason: 'stopless blackbox provider protocol truth'
  });
  writeMetadataCenterSlot({
    target: metadata,
    family: 'runtime_control',
    key: 'preselectedRoute',
    value: STOPLESS_HARNESS_ROUTE_CONTROL.preselectedRoute,
    writer: {
      module: 'scripts/tests/stopless-contract-blackbox.mjs',
      symbol: 'withStoplessHarnessRouteControl',
      stage: 'test'
    },
    reason: 'stopless blackbox preselected route'
  });
  return {
    ...input,
    metadata
  };
}

function buildConfig(upstreamBase) {
  const routing = {
    thinking: [{ id: 'thinking', priority: 100, mode: 'round-robin', targets: ['crs1.gpt-5.3-codex'] }],
    default: [{ id: 'default', priority: 10, mode: 'round-robin', targets: ['crs1.gpt-5.3-codex'] }]
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
        crs1: makeProvider('crs1', upstreamBase)
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

function parseJsonOrSseResponse(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const response = {};
  const blocks = trimmed.split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    const payload = JSON.parse(data);
    const candidate = payload?.response && typeof payload.response === 'object'
      ? payload.response
      : payload;
    if (candidate && typeof candidate === 'object') {
      Object.assign(response, candidate);
    }
  }
  return response;
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

function extractToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) => tool?.name ?? tool?.function?.name ?? null)
    .filter((value) => typeof value === 'string');
}

function findTool(tools, toolName) {
  if (!Array.isArray(tools)) {
    return null;
  }
  return tools.find((tool) => (tool?.name ?? tool?.function?.name) === toolName) ?? null;
}

function assertStoplessSystemInstructionContract(text, label) {
  const value = String(text || '');
  assert.ok(value.includes('<rcc_stop_schema>'), `${label} missing rcc_stop_schema tag: ${value}`);
  assert.ok(
    value.includes('字段不是全局必填，而是关系必填'),
    `${label} missing conditional-field system guidance: ${value}`
  );
  assert.ok(
    value.includes('stopreason=0') && value.includes('has_evidence=1') && value.includes('evidence'),
    `${label} missing has_evidence/evidence relation: ${value}`
  );
  assert.ok(
    value.includes('stopreason=1') && value.includes('reason') && value.includes('提供 reason 即可停止'),
    `${label} missing blocked/reason relation: ${value}`
  );
  assert.ok(
    value.includes('stopreason=2') && value.includes('next_step'),
    `${label} missing continue/next_step relation: ${value}`
  );
  assert.ok(
    value.includes('needs_user_input=true') && value.includes('next_step'),
    `${label} missing user-decision relation: ${value}`
  );
  assert.ok(value.includes('最小可复制样本'), `${label} missing minimal sample: ${value}`);
}

function assertReasoningStopToolContract(tool, label) {
  assert.ok(tool, `${label} missing reasoningStop tool`);
  const fn = tool.function ?? tool;
  const description = String(fn.description || '');
  assert.ok(
    description.includes('Fields are conditionally required, not globally required'),
    `${label} missing conditional-field tool description: ${description}`
  );
  assert.ok(
    description.includes('stopreason=1 blocked requires non-empty reason')
      && description.includes('may stop with reason only'),
    `${label} missing blocked/reason tool description: ${description}`
  );
  assert.ok(
    description.includes('stopreason=2 continue_needed requires next_step'),
    `${label} missing continue/next_step tool description: ${description}`
  );
  assert.ok(
    description.includes('needs_user_input=true requires next_step'),
    `${label} missing user-decision tool description: ${description}`
  );
  assert.ok(
    description.includes('Minimal continue sample') && description.includes('Minimal finished sample'),
    `${label} missing tool samples: ${description}`
  );
  assert.ok(!description.includes('fill every field'), `${label} retained all-fields wording: ${description}`);
  const required = fn.parameters?.required ?? fn.input_schema?.required ?? [];
  assert.deepEqual(
    [...required].sort(),
    ['stopreason'],
    `${label} reasoningStop required fields must be unconditional baseline only`
  );
}

function extractInputJson(command) {
  const match = String(command).match(/--input-json '([^']+)'(?=\s--|$)/u);
  return JSON.parse(match?.[1] ?? '{}');
}

function hasStopSchemaContractText(text) {
  const value = String(text || '');
  return value.includes('<rcc_stop_schema>')
    && (
      value.includes('stopreason 取值：0=finished，1=blocked，2=continue_needed')
      || value.includes('stopreason values: 0=finished, 1=blocked, 2=continue_needed')
    )
    && (
      value.includes('字段不是全局必填，而是关系必填')
      || value.includes('Fields are conditionally required, not globally required')
    )
    && value.includes('next_step');
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

function buildReasoningStopCommand(schema, requestId, projectionInput = {}) {
  const projectionBase = {
    ...(typeof projectionInput.flowId === 'string' ? { flowId: projectionInput.flowId } : {}),
    ...(typeof projectionInput.repeatCount === 'number' ? { repeatCount: projectionInput.repeatCount } : {}),
    ...(typeof projectionInput.maxRepeats === 'number' ? { maxRepeats: projectionInput.maxRepeats } : {})
  };
  const payload = {
    ...projectionBase,
    ...schema
  };
  const encoded = JSON.stringify(payload).replace(/'/g, `'\\''`);
  const parts = [
    'routecodex hook run reasoningStop',
    `--input-json '${encoded}'`,
  ];
  if (requestId) {
    parts.push(`--request-id '${requestId}'`);
  }
  return parts.join(' ');
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

const CASES = [
  {
    id: 'no_schema',
    buildCliOutput({ command }) {
      return runCliCommand(command);
    },
    expectedReasonCode: 'stop_schema_missing',
    expectedTriggerHint: 'no_schema',
    expectCliSchemaFeedback: false,
    expectedProviderText: '上一轮执行结果：repeatCount=1/3',
    expectedMissingFields: ['stopreason']
  },
  {
    id: 'invalid_schema',
    buildCliOutput({ command, requestId }) {
      const projectionInput = extractInputJson(command);
      return runCliCommand(buildReasoningStopCommand({
        stopreason: 2,
        reason: '还没完成',
        has_evidence: 0,
        evidence: '',
        issue_cause: '',
        excluded_factors: '',
        diagnostic_order: '',
        done_steps: '',
        next_suggested_path: '',
        needs_user_input: false,
        learned: ''
      }, requestId, projectionInput));
    },
    expectedReasonCode: 'stop_schema_next_step_missing',
    expectedTriggerHint: 'invalid_schema',
    expectCliSchemaFeedback: true,
    expectedProviderText: 'stop_schema_next_step_missing',
    expectedMissingFields: ['next_step']
  },
  {
    id: 'next_step',
    buildCliOutput({ command, requestId }) {
      const projectionInput = extractInputJson(command);
      return runCliCommand(buildReasoningStopCommand({
        stopreason: 2,
        reason: '还没收尾',
        has_evidence: 1,
        evidence: 'have logs',
        issue_cause: '',
        excluded_factors: '',
        diagnostic_order: '1. inspect',
        done_steps: 'checked logs',
        next_step: 'rerun failing command',
        next_suggested_path: 'continue',
        needs_user_input: false,
        learned: 'need one more run'
      }, requestId, projectionInput));
    },
    expectedReasonCode: 'stop_schema_continue_next_step',
    expectedTriggerHint: 'non_terminal_schema',
    expectCliSchemaFeedback: true,
    expectedProviderText: 'stop_schema_continue_next_step'
  }
];

async function runCase(testCase) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `rcc-stopless-contract-${testCase.id}-`));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  const sessionId = `stopless-contract-${testCase.id}-${Date.now()}`;
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '1'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '1')
  ];

  let upstreamServer;
  let harnessServer;
  let upstreamHits = [];

  try {
    const upstreamApp = express();
    upstreamApp.use(express.json({ limit: '2mb' }));
    upstreamApp.use((req, _res, next) => {
      console.error('[stopless-contract-blackbox] upstream request', req.method, req.path);
      next();
    });
    upstreamApp.all('*', (req, res) => {
      upstreamHits.push(req.body);
      if (String(req.path).includes('/models')) {
        return res.json({ data: [{ id: 'gpt-5.3-codex' }] });
      }
      if (String(req.path).includes('/submit_tool_outputs')) {
        return res.json(upstreamResponse(`submit_tool_outputs stop: ${testCase.id}`));
      }
      return res.json(upstreamResponse(
        upstreamHits.length === 1
          ? '第一轮普通 stop，无 schema'
          : `第二轮继续 stop: ${testCase.id}`
      ));
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
    const first = await fetch(`${harnessServer.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify(firstPayload)
    });

    const firstText = await first.text();
    const firstBody = JSON.parse(firstText);
    const firstExec = findExecCommandTool(firstBody);
    const firstProviderPayload = upstreamHits[0] ?? {};
    const firstProviderText = JSON.stringify(firstProviderPayload);
    const firstProviderTools = extractToolNames(firstProviderPayload.tools);

    assert.equal(first.status, 200, `case=${testCase.id} expected first response 200, body=${firstText}`);
    assert.ok(firstExec, `case=${testCase.id} expected exec_command, body=${firstText}`);
    assert.ok(hasStopSchemaContractText(firstProviderText), `case=${testCase.id} missing stop schema contract in provider-request: ${firstProviderText}`);
    assertStoplessSystemInstructionContract(firstProviderText, `case=${testCase.id} first provider-request system instruction`);
    assert.ok(firstProviderTools.includes('reasoningStop'), `case=${testCase.id} missing reasoningStop tool in first provider-request: ${JSON.stringify(firstProviderPayload)}`);
    assertReasoningStopToolContract(
      findTool(firstProviderPayload.tools, 'reasoningStop'),
      `case=${testCase.id} first provider-request`
    );
    assert.ok(firstProviderTools.includes('exec_command'), `case=${testCase.id} missing exec_command tool in first provider-request: ${JSON.stringify(firstProviderPayload)}`);
    assert.ok(!JSON.stringify(firstBody).includes('"reasoningStop"'), `case=${testCase.id} client payload leaked raw reasoningStop: ${firstText}`);

    const cliOutput = testCase.buildCliOutput({
      command: firstExec.command,
      requestId: firstBody.request_id ?? null,
      responseId: firstBody.id
    });
    if (cliOutput?.schemaGuidance) {
      assert.equal(cliOutput.schemaGuidance.triggerHint, testCase.expectedTriggerHint, `case=${testCase.id} unexpected cli schemaGuidance triggerHint: ${JSON.stringify(cliOutput)}`);
    }
    assert.equal(cliOutput?.input?.triggerHint, testCase.expectedTriggerHint, `case=${testCase.id} unexpected cli input triggerHint: ${JSON.stringify(cliOutput)}`);
    if (testCase.expectCliSchemaFeedback) {
      assert.equal(cliOutput?.schemaFeedback?.reasonCode, testCase.expectedReasonCode, `case=${testCase.id} unexpected cli schemaFeedback: ${JSON.stringify(cliOutput)}`);
    } else {
      assert.ok(!cliOutput?.schemaFeedback, `case=${testCase.id} expected no top-level cli schemaFeedback: ${JSON.stringify(cliOutput)}`);
    }
    if (testCase.expectedMissingFields && testCase.expectCliSchemaFeedback) {
      assert.ok(
        Array.isArray(cliOutput?.schemaFeedback?.missingFields)
          && testCase.expectedMissingFields.every((field) => cliOutput.schemaFeedback.missingFields.includes(field)),
        `case=${testCase.id} unexpected cli missingFields: ${JSON.stringify(cliOutput)}`
      );
    }
    const submit = await fetch(`${harnessServer.baseUrl}/v1/responses/${encodeURIComponent(firstBody.id)}/submit_tool_outputs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'x-conversation-id': sessionId
      },
      body: JSON.stringify({
        tool_outputs: [{
          tool_call_id: firstExec.callId,
          output: JSON.stringify(cliOutput)
        }]
      })
    });
    const submitText = await submit.text();
    const submitBody = parseJsonOrSseResponse(submitText);
    const secondExec = findExecCommandTool(submitBody);
    const secondInput = extractInputJson(secondExec?.command ?? '');
    const secondProviderPayload = upstreamHits[1] ?? {};
    const secondProviderText = JSON.stringify(secondProviderPayload);
    const secondProviderInput = Array.isArray(secondProviderPayload.input) ? secondProviderPayload.input : [];
    const secondProviderCurrentTurnText = JSON.stringify(secondProviderInput.slice(-2));
    const secondProviderTools = extractToolNames(secondProviderPayload.tools);

    assert.equal(submit.status, 200, `case=${testCase.id} expected submit_tool_outputs 200, body=${submitText}`);
    assert.equal(upstreamHits.length, 2, `case=${testCase.id} expected 2 upstream hits, hits=${JSON.stringify(upstreamHits)}`);
    assert.ok(secondExec, `case=${testCase.id} expected second-round exec_command, body=${submitText}`);
    assert.ok(hasStopSchemaContractText(secondProviderText), `case=${testCase.id} missing stop schema guidance in second provider-request: ${secondProviderText}`);
    assert.ok(secondProviderText.includes('reasoningStop'), `case=${testCase.id} missing reasoningStop semantics in second provider-request: ${secondProviderText}`);
    assert.ok(secondProviderText.includes(testCase.expectedProviderText), `case=${testCase.id} missing expected provider feedback ${testCase.expectedProviderText}: ${secondProviderText}`);
    assert.ok(secondProviderTools.includes('reasoningStop'), `case=${testCase.id} missing reasoningStop tool in second provider-request: ${JSON.stringify(secondProviderPayload)}`);
    assert.ok(secondProviderTools.includes('exec_command'), `case=${testCase.id} missing exec_command tool in second provider-request: ${JSON.stringify(secondProviderPayload)}`);
    assert.ok(!JSON.stringify(submitBody).includes('"reasoningStop"'), `case=${testCase.id} client submit_tool_outputs response leaked raw reasoningStop: ${submitText}`);
    assert.equal(secondInput.triggerHint, 'no_schema', `case=${testCase.id} unexpected client exec_command triggerHint: ${JSON.stringify(secondInput)}`);
    assert.equal(secondInput.repeatCount, 2, `case=${testCase.id} unexpected client exec_command repeatCount: ${JSON.stringify(secondInput)}`);
    assert.equal(secondInput.maxRepeats, 3, `case=${testCase.id} unexpected client exec_command maxRepeats: ${JSON.stringify(secondInput)}`);
    assert.ok(
      secondProviderCurrentTurnText.includes('上一轮执行结果：repeatCount=1/3')
        && secondProviderCurrentTurnText.includes(testCase.expectedProviderText),
      `case=${testCase.id} second provider-request must rewrite CLI output into current-turn model-visible stopless guidance: ${secondProviderCurrentTurnText}`
    );
    assert.ok(
      !secondProviderCurrentTurnText.includes('"name":"exec_command"')
        && !secondProviderCurrentTurnText.includes('stop_message_auto')
        && !secondProviderCurrentTurnText.includes('routecodex hook run'),
      `case=${testCase.id} second provider-request current-turn guidance must not replay raw shell/stop_message_auto history: ${secondProviderCurrentTurnText}`
    );
  } finally {
    if (upstreamServer) {
      try {
        console.error('[stopless-contract-blackbox] upstreamHits', JSON.stringify(upstreamHits ?? []));
      } catch {
        // non-blocking
      }
    }
    await close(harnessServer?.server);
    await close(upstreamServer?.server);
    for (const restore of restores.reverse()) restore();
  }
}

async function main() {
  for (const testCase of CASES) {
    await runCase(testCase);
  }
  console.log(JSON.stringify({
    ok: true,
    cases: CASES.map((item) => item.id)
  }, null, 2));
}

main().then(() => {
  setTimeout(() => process.exit(0), 20);
}).catch((error) => {
  console.error('[stopless-contract-blackbox] failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
