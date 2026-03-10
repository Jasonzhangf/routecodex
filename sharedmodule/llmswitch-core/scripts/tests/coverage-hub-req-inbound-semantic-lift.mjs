#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_inbound',
    'req_inbound_stage2_semantic_map',
    'semantic-lift.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-hub-req-inbound-semantic-lift-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeAdapterContext(overrides = {}) {
  return {
    requestId: 'req_semantic_lift',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    ...overrides
  };
}

function makeChatEnvelope() {
  return {
    messages: [],
    metadata: {
      context: makeAdapterContext()
    }
  };
}

function makeFormatEnvelope(payload = {}, protocol = 'openai-chat') {
  return {
    protocol,
    payload
  };
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const mod = await importFresh('hub-req-inbound-semantic-lift');
  const liftReqInboundSemantics = mod.liftReqInboundSemantics;
  const mapResumeToolOutputsDetailed = mod.mapResumeToolOutputsDetailed;

  assert.equal(typeof liftReqInboundSemantics, 'function');
  assert.equal(typeof mapResumeToolOutputsDetailed, 'function');

  {
    const rawTools = [{ name: 'Read' }, { name: 'Bash' }];
    const chatEnvelope = makeChatEnvelope();
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: makeFormatEnvelope({ tools: rawTools }),
      adapterContext: makeAdapterContext()
    });

    const semantics = chatEnvelope.semantics;
    assert.ok(semantics);
    assert.deepEqual(semantics.tools.clientToolsRaw, rawTools);
    assert.notEqual(semantics.tools.clientToolsRaw, rawTools);
    assert.equal(semantics.tools.toolNameAliasMap, undefined);
  }

  {
    const chatEnvelope = makeChatEnvelope();
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: { payload: undefined, protocol: undefined },
      adapterContext: {}
    });
    assert.ok(chatEnvelope.semantics);
    assert.deepEqual(chatEnvelope.semantics.tools, {});
  }

  {
    const chatEnvelope = makeChatEnvelope();
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: { payload: { tools: [{ name: 'Bash' }] }, protocol: undefined },
      adapterContext: {}
    });
    assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap, undefined);
  }

  {
    const chatEnvelope = makeChatEnvelope();
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: makeFormatEnvelope({ tools: [{ name: 'Bash' }] }, 'anthropic-messages'),
      adapterContext: makeAdapterContext({ entryEndpoint: '/v1/messages' })
    });
    assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap.bash, 'Bash');
    assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap.shell_command, undefined);
    assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap.exec_command, undefined);
  }

  {
    const chatEnvelope = makeChatEnvelope();
    chatEnvelope.semantics = {
      tools: {
        toolNameAliasMap: {
          shell_command: 'KeepExisting'
        }
      }
    };
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: makeFormatEnvelope({ tools: [{ name: 'Bash' }] }, 'anthropic-messages'),
      adapterContext: makeAdapterContext({ entryEndpoint: '/v1/messages' })
    });
    assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap.shell_command, 'KeepExisting');
  }

  {
    const circular = {};
    circular.self = circular;
    const chatEnvelope = makeChatEnvelope();
    chatEnvelope.semantics = {
      responses: {
        resume: { existing: true }
      }
    };
    const responsesResume = {
      toolOutputsDetailed: [
        { callId: '  call_1  ', outputText: 'ok' },
        { originalId: ' orig_2 ', outputText: { answer: 42 } },
        { outputText: circular },
        null
      ]
    };
    assert.throws(
      () =>
        liftReqInboundSemantics({
          chatEnvelope,
          formatEnvelope: makeFormatEnvelope({}),
          adapterContext: makeAdapterContext(),
          responsesResume
        }),
      /applyReqInboundSemanticLiftJson.*json stringify failed/
    );
    assert.deepEqual(chatEnvelope.semantics.responses.resume, { existing: true });
    assert.equal(chatEnvelope.toolOutputs, undefined);
  }

  {
    const chatEnvelope = makeChatEnvelope();
    chatEnvelope.toolOutputs = [{ tool_call_id: 'direct', content: 'keep' }];
    liftReqInboundSemantics({
      chatEnvelope,
      formatEnvelope: makeFormatEnvelope({}),
      adapterContext: makeAdapterContext(),
      responsesResume: {
        toolOutputsDetailed: [{ callId: 'new_id', outputText: 'new_output' }]
      }
    });
    assert.deepEqual(chatEnvelope.toolOutputs, [{ tool_call_id: 'direct', content: 'keep' }]);
  }

  {
    const circular = {};
    circular.self = circular;
    assert.throws(
      () =>
        mapResumeToolOutputsDetailed({
          toolOutputsDetailed: [{ callId: 'cycle', outputText: circular }]
        }),
      /mapResumeToolOutputsDetailedJson.*json stringify failed/
    );
  }

  {
    assert.deepEqual(mapResumeToolOutputsDetailed({}), []);
    assert.deepEqual(
      mapResumeToolOutputsDetailed({
        toolOutputsDetailed: [{ callId: ' ', originalId: ' ', outputText: undefined }, 123]
      }),
      [{ tool_call_id: 'resume_tool_1', content: '""' }]
    );
  }

  await withTempNativeModule(
    `
exports.applyReqInboundSemanticLiftJson = (inputJson) => {
  const input = JSON.parse(inputJson);
  const envelope = input.chatEnvelope || {};
  const semantics = envelope.semantics || {};
  const tools = semantics.tools || {};
  return JSON.stringify({
    semantics: {
      ...semantics,
      tools: {
        ...tools,
        clientToolsRaw: [{ name: 'NativeTool' }],
        toolNameAliasMap: { bash: 'NativeBash' }
      },
      responses: { resume: { fromNative: true } }
    },
    toolOutputs: [{ tool_call_id: 'native_call', content: 'native_output' }]
  });
};
exports.mapResumeToolOutputsDetailedJson = () => JSON.stringify([{ tool_call_id: 'native_resume_1', content: 'native_resume_output' }]);
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-req-inbound-semantic-lift-native');
      const chatEnvelope = makeChatEnvelope();
      chatEnvelope.extraField = 'drop-me';
      modNative.liftReqInboundSemantics({
        chatEnvelope,
        formatEnvelope: makeFormatEnvelope({ tools: [{ name: 'Bash' }] }, 'anthropic-messages'),
        adapterContext: makeAdapterContext({ entryEndpoint: '/v1/messages' }),
        responsesResume: { toolOutputsDetailed: [{ callId: 'fallback', outputText: 'fallback' }] }
      });

      // Explicit native path now allows partial mock exports for focused capability tests.
      assert.deepEqual(chatEnvelope.semantics.tools.clientToolsRaw, [{ name: 'NativeTool' }]);
      assert.equal(chatEnvelope.semantics.tools.toolNameAliasMap.bash, 'NativeBash');
      assert.equal(chatEnvelope.semantics.responses.resume.fromNative, true);
      assert.deepEqual(chatEnvelope.toolOutputs, [{ tool_call_id: 'native_call', content: 'native_output' }]);
      assert.equal(Object.prototype.hasOwnProperty.call(chatEnvelope, 'extraField'), false);
    }
  );

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-req-inbound-semantic-lift passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-inbound-semantic-lift failed:', error);
  process.exit(1);
});
