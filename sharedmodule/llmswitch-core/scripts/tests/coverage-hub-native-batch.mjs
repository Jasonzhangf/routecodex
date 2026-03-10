#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function setEnvVar(key, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

async function withTempNativeModule(content, run) {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-native-batch-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await run(file);
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createMockNativeModuleSource() {
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = { ...real,',
    '  parseFormatEnvelopeJson(inputJson) {',
    '    const input = JSON.parse(inputJson);',
    '    const envelope = { format: input.protocol, payload: input.rawRequest, metadata: { mocked: true } };',
    '    return JSON.stringify({ envelope });',
    '  },',
    '  parseRespFormatEnvelopeJson(inputJson) {',
    '    const input = JSON.parse(inputJson);',
    '    const envelope = { format: input.protocol, payload: input.payload, metadata: { mocked: true } };',
    '    return JSON.stringify({ envelope });',
    '  },',
    '  parseLenientJsonishJson(valueJson) {',
    '    const decoded = JSON.parse(valueJson);',
    '    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {',
    '      return JSON.stringify(decoded);',
    '    }',
    '    if (typeof decoded === "string") {',
    '      try {',
    '        const nested = JSON.parse(decoded);',
    '        if (nested && typeof nested === "object" && !Array.isArray(nested)) {',
    '          return JSON.stringify(nested);',
    '        }',
    '      } catch {}',
    '    }',
    '    return JSON.stringify({});',
    '  },',
    '};'
  ].join('\n');
}

function createRulesCoverageNativeModuleSource() {
  const rulesPayload = {
    'openai-chat': {
      request: {},
      response: {}
    },
    'openai-responses': {
      request: {
        maxNameLength: 'not-a-number',
        allowedCharacters: 'lower_snake',
        onViolation: 'reject'
      },
      response: {
        defaultName: '   '
      }
    },
    anthropic: {}
  };
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = { ...real,',
    `  resolveDefaultToolGovernanceRulesJson() { return JSON.stringify(${JSON.stringify(rulesPayload)}); },`,
    '};'
  ].join('\n');
}

function makeAdapterContext() {
  return {
    requestId: 'req-batch',
    endpoint: '/v1/chat/completions',
    providerId: 'mock-provider'
  };
}

function makeCircular() {
  const value = {};
  value.self = value;
  return value;
}

async function runFormatAdapterCoverage() {
  const modules = await Promise.all([
    cacheBustedImport(
      moduleUrl('conversion/hub/format-adapters/chat-format-adapter.js'),
      'chat-format-adapter'
    ),
    cacheBustedImport(
      moduleUrl('conversion/hub/format-adapters/responses-format-adapter.js'),
      'responses-format-adapter'
    ),
    cacheBustedImport(
      moduleUrl('conversion/hub/format-adapters/anthropic-format-adapter.js'),
      'anthropic-format-adapter'
    ),
    cacheBustedImport(
      moduleUrl('conversion/hub/format-adapters/gemini-format-adapter.js'),
      'gemini-format-adapter'
    )
  ]);

  const ctx = makeAdapterContext();
  const [
    { ChatFormatAdapter },
    { ResponsesFormatAdapter },
    { AnthropicFormatAdapter },
    { GeminiFormatAdapter }
  ] = modules;

  const adapters = [
    { inst: new ChatFormatAdapter(), payload: { messages: [{ role: 'user', content: 'hi' }] } },
    { inst: new ResponsesFormatAdapter(), payload: { input: [{ role: 'user', content: 'hi' }] } },
    { inst: new AnthropicFormatAdapter(), payload: { messages: [{ role: 'user', content: 'hi' }] } },
    { inst: new GeminiFormatAdapter(), payload: { contents: [{ role: 'user', parts: [] }] } }
  ];

  for (const { inst, payload } of adapters) {
    const reqEnvelope = await inst.parseRequest(payload, ctx);
    assert.equal(reqEnvelope.protocol, inst.protocol);
    assert.equal(reqEnvelope.direction, 'request');
    const reqBuilt = await inst.buildRequest(reqEnvelope, ctx);
    assert.equal(reqBuilt, reqEnvelope.payload);

    const respEnvelope = await inst.parseResponse(payload, ctx);
    assert.equal(respEnvelope.protocol, inst.protocol);
    assert.equal(respEnvelope.direction, 'response');
    const respBuilt = await inst.buildResponse(respEnvelope, ctx);
    assert.equal(respBuilt, respEnvelope.payload);
  }
}

async function runMapperExportCoverage() {
  const [chat, responses, anthropic, gemini] = await Promise.all([
    cacheBustedImport(moduleUrl('conversion/hub/semantic-mappers/chat-mapper.js'), 'chat-mapper'),
    cacheBustedImport(moduleUrl('conversion/hub/semantic-mappers/responses-mapper.js'), 'responses-mapper'),
    cacheBustedImport(moduleUrl('conversion/hub/semantic-mappers/anthropic-mapper.js'), 'anthropic-mapper'),
    cacheBustedImport(moduleUrl('conversion/hub/semantic-mappers/gemini-mapper.js'), 'gemini-mapper')
  ]);
  assert.equal(typeof chat.mapReqInboundBridgeToolsToChatWithNative, 'function');
  assert.equal(typeof responses.normalizeProviderProtocolTokenWithNative, 'function');
  assert.equal(typeof anthropic.buildAnthropicToolAliasMapWithNative, 'function');
  assert.equal(typeof gemini.applyClaudeThinkingToolSchemaCompatWithNative, 'function');
}

async function runSnapshotRecorderCoverage() {
  const mod = await cacheBustedImport(moduleUrl('conversion/hub/snapshot-recorder.js'), 'snapshot-recorder');
  const { SnapshotStageRecorder, createSnapshotRecorder } = mod;
  assert.equal(typeof SnapshotStageRecorder, 'function');
  assert.equal(typeof createSnapshotRecorder, 'function');

  setEnvVar('ROUTECODEX_HUB_SNAPSHOTS', '0');
  {
    const recorder = new SnapshotStageRecorder({
      context: makeAdapterContext(),
      endpoint: '/v1/chat/completions'
    });
    recorder.record('unknown-stage', { ok: true });
  }

  setEnvVar('ROUTECODEX_HUB_SNAPSHOTS', '1');
  {
    const recorder = new SnapshotStageRecorder({
      context: {
        ...makeAdapterContext(),
        clientRequestId: 'client-group'
      },
      endpoint: '/v1/messages'
    });
    const captured = [];
    recorder.writer = (stage, payload) => {
      captured.push({ stage, payload });
    };

    recorder.record('unknown-stage', { passthrough: true });
    recorder.record('unknown-stage', undefined);
    recorder.record('req_inbound_stage2_semantic_map', { not: 'chat-envelope' });
    recorder.record('req_inbound_stage2_semantic_map', {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      toolOutputs: [{ type: 'tool_result', content: 'ok' }],
      parameters: { model: 'gpt-test' },
      metadata: {
        context: { cwd: '/tmp' },
        missingFields: ['tools'],
        misc: 1
      }
    });
    recorder.record('resp_inbound_stage3_semantic_map', { choices: [{ index: 0 }] });

    const circular = makeCircular();
    recorder.record('resp_outbound_stage1_client_remap', circular);

    recorder.writer = () => {
      throw new Error('write failed');
    };
    recorder.record('req_outbound_stage1_semantic_map', {
      messages: [{ role: 'user', content: 'ignored' }],
      metadata: {}
    });

    assert.ok(captured.length >= 4);
    assert.equal(captured[0].stage, 'unknown-stage');
    const reqSnap = captured.find(
      (item) => item.stage === 'req_inbound_stage2_semantic_map' && Array.isArray(item.payload?.messages)
    );
    const respInSnap = captured.find((item) => item.stage === 'resp_inbound_stage3_semantic_map');
    const respOutSnap = captured.find((item) => item.stage === 'resp_outbound_stage1_client_remap');
    assert.ok(reqSnap);
    assert.ok(respInSnap);
    assert.ok(respOutSnap);
    assert.equal(reqSnap.payload.messages.length, 1);
    assert.equal(Array.isArray(reqSnap.payload.tools), true);
    assert.equal(reqSnap.payload.meta.context.cwd, '/tmp');
    assert.equal(respInSnap.payload.choices[0].index, 0);
    assert.equal(respOutSnap.payload, circular);
  }

  const recorderApi = createSnapshotRecorder(makeAdapterContext(), '/v1/chat/completions');
  assert.equal(typeof recorderApi.record, 'function');
}

async function runStageUtilsCoverage() {
  const mod = await cacheBustedImport(
    moduleUrl('conversion/hub/pipeline/stages/utils.js'),
    'pipeline-stage-utils'
  );
  const { recordStage } = mod;
  assert.equal(typeof recordStage, 'function');

  recordStage(undefined, 'stage.none', { ok: true });

  const captured = [];
  const recorder = {
    record(stage, payload) {
      captured.push({ stage, payload });
    }
  };

  recordStage(recorder, 'stage.object', { x: 1 });
  recordStage(recorder, 'stage.string-json', '{"hello":"world"}');
  recordStage(recorder, 'stage.bigint', 1n);

  const throwingRecorder = {
    record() {
      throw new Error('recorder boom');
    }
  };
  recordStage(throwingRecorder, 'stage.throw', { ok: true });

  assert.equal(captured[0].payload.x, 1);
  assert.equal(captured[1].payload.hello, 'world');
  assert.equal(Object.keys(captured[2].payload).length, 0);
}

async function runRulesCoverage() {
  const mod = await cacheBustedImport(
    moduleUrl('conversion/hub/tool-governance/rules.js'),
    'tool-governance-rules'
  );
  assert.equal(typeof mod.DEFAULT_TOOL_GOVERNANCE_RULES, 'object');
  assert.equal(mod.DEFAULT_TOOL_GOVERNANCE_RULES['openai-chat'].request.maxNameLength, 64);

  await withTempNativeModule(createRulesCoverageNativeModuleSource(), async (modulePath) => {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
    const edgeMod = await cacheBustedImport(
      moduleUrl('conversion/hub/tool-governance/rules.js'),
      'tool-governance-rules-edge'
    );
    const rules = edgeMod.DEFAULT_TOOL_GOVERNANCE_RULES;
    assert.equal(rules['openai-chat'].request.maxNameLength, 64);
    assert.equal(rules['openai-responses'].request.onViolation, 'reject');
    assert.equal(rules['openai-responses'].request.maxNameLength, 64);
    assert.equal(rules.anthropic.request.forceCase, 'lower');
    assert.equal(rules.gemini.response.maxNameLength, 64);
  });
}

async function runToolGovernanceEngineCoverage() {
  const mod = await cacheBustedImport(
    moduleUrl('conversion/hub/tool-governance/engine.js'),
    'tool-governance-engine'
  );
  const { ToolGovernanceEngine, ToolGovernanceError } = mod;
  assert.equal(typeof ToolGovernanceEngine, 'function');
  assert.equal(typeof ToolGovernanceError, 'function');

  const registry = {
    'openai-chat': {
      request: {
        maxNameLength: 4,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        forceCase: 'lower',
        onViolation: 'truncate'
      },
      response: {
        maxNameLength: 5,
        allowedCharacters: /[A-Za-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        forceCase: 'upper',
        onViolation: 'truncate'
      }
    },
    gemini: {
      request: {
        maxNameLength: 3,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'reject'
      },
      response: {
        maxNameLength: 3,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'reject'
      }
    }
  };

  const engine = new ToolGovernanceEngine(registry);
  const req = {
    model: 'gpt-test',
    messages: [
      {
        role: 'tool',
        name: '  BAD_NAME_12345  ',
        tool_calls: [
          1,
          { function: { name: 'abcd', arguments: '{}' } },
          { function: { name: '@@@', arguments: '{}' } },
          {}
        ]
      },
      { role: 'tool' },
      { role: 'user', content: 'hi' }
    ],
    tools: [
      { type: 'function', function: { name: 'LONG_TOOL_NAME', parameters: {} } },
      { type: 'function', function: { name: 'abcd', parameters: {} } },
      { type: 'function', function: { parameters: {} } },
      { type: 'function', function: { name: 'ok', parameters: {} } }
    ],
    metadata: {}
  };

  const governedReq = engine.governRequest(req, 'openai-chat');
  assert.equal(governedReq.summary.applied, true);
  assert.equal(typeof governedReq.request.metadata.toolGovernance.request.timestamp, 'number');

  const governedReqFromAlias = engine.governRequest(req, 'openai-responses');
  assert.equal(governedReqFromAlias.summary.applied, true);

  const governedReqDefaultProtocol = engine.governRequest(req, undefined);
  assert.equal(governedReqDefaultProtocol.summary.applied, true);

  const governedReqUnknownProtocol = engine.governRequest(req, 'custom-protocol');
  assert.equal(governedReqUnknownProtocol.summary.applied, true);

  const governedReqAnthropic = engine.governRequest(req, 'anthropic-messages');
  assert.equal(governedReqAnthropic.summary.applied, true);

  assert.throws(
    () =>
      engine.governRequest(
        {
          ...req,
          messages: [{ role: 'tool', name: 'TOO-LONG-NAME-REJECT' }]
        },
        'gemini-chat'
      ),
    ToolGovernanceError
  );

  const responsePayload = {
    choices: [
      {},
      {
        message: {
          role: 'assistant',
          tool_calls: [1, {}, { function: { name: 'ABCDE', arguments: '{}' } }, { function: { name: 'BAD$$NAME', arguments: '{}' } }],
          function_call: { name: 'TOOL_123', arguments: '{}' },
          name: 'mixedCase'
        }
      }
    ],
    tool_calls: [1, {}, { function: { name: 'ABCDE', arguments: '{}' } }, { function: { name: 'ANOTHER_BAD$$$', arguments: '{}' } }]
  };
  const governedResp = engine.governResponse(responsePayload, 'responses');
  assert.equal(governedResp.summary.applied, true);
  assert.equal(Array.isArray(governedResp.payload.choices), true);
  assert.equal(Array.isArray(governedResp.payload.tool_calls), true);

  const responseEdgeEngine = new ToolGovernanceEngine({
    'openai-chat': {
      request: {
        maxNameLength: 16,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'truncate'
      },
      response: {
        maxNameLength: 3,
        allowedCharacters: /[a-z]/,
        trimWhitespace: true,
        forceCase: 'lower',
        onViolation: 'truncate'
      }
    }
  });

  const responseEdgePayload = {
    id: 'resp-edge',
    choices: [
      {},
      {
        message: {
          role: 'assistant',
          tool_calls: [
            { function: { name: '$$$$', arguments: '{}' } },
            { function: { name: 123, arguments: '{}' } }
          ],
          function_call: { name: 123, arguments: '{}' }
        }
      },
      {
        message: {
          role: 'tool',
          name: 'ABC'
        }
      }
    ],
    tool_calls: [{ function: { name: '$$$$', arguments: '{}' } }]
  };
  const governedEdgeResp = responseEdgeEngine.governResponse(responseEdgePayload, 'openai-chat');
  assert.equal(governedEdgeResp.payload.choices[1].message.tool_calls[0].function.name, 'too');
  assert.equal(governedEdgeResp.payload.choices[1].message.function_call.name, 'too');
  assert.equal(governedEdgeResp.payload.choices[2].message.name, 'abc');

  const noChoicesResp = responseEdgeEngine.governResponse(
    { id: 'resp-no-choices', tool_calls: [] },
    'openai-chat'
  );
  assert.equal(noChoicesResp.summary.applied, false);

  const responseRejectEngine = new ToolGovernanceEngine({
    'openai-chat': {
      request: {
        maxNameLength: 8,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'truncate'
      },
      response: {
        maxNameLength: 2,
        allowedCharacters: /[a-z]/,
        defaultName: '',
        trimWhitespace: true,
        onViolation: 'reject'
      }
    }
  });

  assert.throws(
    () =>
      responseRejectEngine.governResponse(
        {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [{ function: { name: 'abcd', arguments: '{}' } }]
              }
            }
          ]
        },
        'openai-chat'
      ),
    ToolGovernanceError
  );

  const noRulesEngine = new ToolGovernanceEngine({});
  const reqNoRules = noRulesEngine.governRequest(req, 'openai-chat');
  assert.equal(reqNoRules.summary.applied, false);
  assert.equal(reqNoRules.request, req);
  const respNoRules = noRulesEngine.governResponse({ id: 'x' }, 'openai-chat');
  assert.equal(respNoRules.summary.applied, false);
}

async function main() {
  const prevSnapshot = process.env.ROUTECODEX_HUB_SNAPSHOTS;
  try {
    await withTempNativeModule(createMockNativeModuleSource(), async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      await runFormatAdapterCoverage();
      await runMapperExportCoverage();
      await runSnapshotRecorderCoverage();
      await runStageUtilsCoverage();
      await runRulesCoverage();
      await runToolGovernanceEngineCoverage();
    });
    console.log('✅ coverage-hub-native-batch passed');
  } finally {
    if (prevSnapshot === undefined) {
      delete process.env.ROUTECODEX_HUB_SNAPSHOTS;
    } else {
      process.env.ROUTECODEX_HUB_SNAPSHOTS = prevSnapshot;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-hub-native-batch failed:', error);
  process.exit(1);
});
