#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'shared', 'chat-request-filters.js')).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');
const fieldMapPath = path.join(repoRoot, 'dist', 'filters', 'config', 'openai-openai.fieldmap.json');

function setEnvVar(key, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importNativeSemanticsFresh(tag) {
  return import(
    pathToFileURL(
      path.join(
        repoRoot,
        'dist',
        'router',
        'virtual-router',
        'engine-selection',
        'native-chat-request-filter-semantics.js'
      )
    ).href + `?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
}

async function withTempNativeModule(content, run) {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-chat-request-filters-native-'));
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

async function withRemovedNativeExport(exportName, run) {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-chat-request-filters-native-missing-'));
  const file = path.join(dir, 'mock-native.cjs');
  const source = [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'const out = { ...real };',
    `delete out[${JSON.stringify(exportName)}];`,
    'module.exports = out;'
  ].join('\n');
  await fs.writeFile(file, source, 'utf8');
  try {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = file;
    await run();
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withMovedFieldMap(run) {
  const backupPath = `${fieldMapPath}.bak.${Date.now()}`;
  await fs.rename(fieldMapPath, backupPath);
  try {
    await run();
  } finally {
    await fs.rename(backupPath, fieldMapPath);
  }
}

function createBaseMockNativeModuleSource() {
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = { ...real,',
    '  buildGovernedFilterPayloadJson(requestJson) {',
    '    const req = JSON.parse(requestJson);',
    '    const obj = req && typeof req === "object" ? req : {};',
    '    const parameters = obj.parameters && typeof obj.parameters === "object" ? obj.parameters : {};',
    '    const out = {',
    '      model: obj.model,',
    '      messages: Array.isArray(obj.messages) ? obj.messages : [],',
    '      stream: obj.stream === true,',
    '      parameters,',
    '    };',
    '    if (obj.tools !== undefined) out.tools = obj.tools;',
    '    if (obj.tool_choice !== undefined) out.tool_choice = obj.tool_choice;',
    '    return JSON.stringify(out);',
    '  },',
    '};'
  ].join('\n');
}

function createContext(overrides = {}) {
  return {
    requestId: 'req-chat-filters',
    entryEndpoint: '/v1/chat/completions',
    endpoint: '/v1/chat/completions',
    metadata: {},
    ...overrides
  };
}

function createProfile(overrides = {}) {
  return {
    id: 'chat-filters-profile',
    incomingProtocol: 'openai-chat',
    outgoingProtocol: 'openai-chat',
    codec: 'openai-openai',
    ...overrides
  };
}

async function main() {
  await withTempNativeModule(createBaseMockNativeModuleSource(), async (modulePath) => {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
    const { runStandardChatRequestFilters } = await importFresh('chat-request-filters-coverage');
    assert.equal(typeof runStandardChatRequestFilters, 'function');

    {
      const out = await runStandardChatRequestFilters(
        {
          messages: [{ role: 'user', content: 'fallback model/requestId/endpoint' }]
        },
        createProfile({ incomingProtocol: undefined, outgoingProtocol: undefined }),
        /** @type {any} */ ({})
      );
      assert.equal(typeof out, 'object');
      assert.equal(Array.isArray(out.messages), true);
    }

    {
      const request = {
        model: 'gpt-4o-mini',
        stream: false,
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: { cmd: 'echo 1' } } },
              { call_id: 'legacy_2', function: { name: 'write_stdin', arguments: { session_id: 1, chars: 'y' } } },
              { id: 'call_3', type: 'function', function: { name: 'clock', arguments: '{"action":"get"}' } },
              { id: 'call_4', type: 'function', function: { name: 'review', arguments: null } }
            ]
          },
          { role: 'tool', call_id: 'legacy_2', content: 'ok', id: 'tool-msg-id' }
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } }
          }
        ],
        metadata: { shouldBeDropped: true },
        __rcc_marker: true,
        originalStream: false,
        _originalStreamOptions: { include_usage: true }
      };

      const out = await runStandardChatRequestFilters(
        request,
        createProfile(),
        createContext({ metadata: { inboundStream: true } })
      );

      assert.equal(typeof out, 'object');
      assert.equal(out.stream, false);
      assert.equal(out.metadata, undefined);
      assert.equal(out.__rcc_marker, undefined);
      assert.equal(out.originalStream, undefined);
      assert.equal(out._originalStreamOptions, undefined);
      assert.equal(Array.isArray(out.messages), true);
      assert.equal(out.messages[1].tool_call_id, 'legacy_2');
      assert.equal('id' in out.messages[1], false);
      assert.equal('call_id' in out.messages[1], false);
      assert.equal('call_id' in out.messages[0].tool_calls[1], false);
      assert.equal('tool_call_id' in out.messages[0].tool_calls[1], false);
      assert.equal(Array.isArray(out.tools), true);
      assert.ok(out.tools.length >= 1);
    }

    {
      const prevSnapshot = process.env.ROUTECODEX_HUB_SNAPSHOTS;
      setEnvVar('ROUTECODEX_HUB_SNAPSHOTS', '0');
      const out = await runStandardChatRequestFilters(
        {
          model: 'gpt-snapshot-off',
          messages: [{ role: 'user', content: 'snapshot off branch' }],
          parameters: {},
          tools: []
        },
        createProfile({ incomingProtocol: 'responses', outgoingProtocol: 'openai-chat' }),
        createContext({ metadata: { inboundStream: 'invalid-bool' } })
      );
      assert.equal(typeof out, 'object');
      if (prevSnapshot === undefined) {
        delete process.env.ROUTECODEX_HUB_SNAPSHOTS;
      } else {
        process.env.ROUTECODEX_HUB_SNAPSHOTS = prevSnapshot;
      }
    }

    {
      const request = {
        model: 'claude-3-7',
        messages: [{ role: 'user', content: 'hello' }],
        parameters: { stream: false }
      };
      const out = await runStandardChatRequestFilters(
        request,
        createProfile({ incomingProtocol: 'anthropic-messages', outgoingProtocol: 'openai-chat' }),
        createContext({ entryEndpoint: '/v1/messages', endpoint: '/v1/messages' })
      );
      assert.equal(Array.isArray(out.tools), true);
      assert.equal(out.__rcc_disable_mcp_tools, undefined);
      assert.equal(out.stream, undefined);
    }

    {
      await withMovedFieldMap(async () => {
        const out = await runStandardChatRequestFilters(
          {
            model: 'gpt-fieldmap-missing',
            messages: [{ role: 'user', content: 'fieldmap missing' }],
            parameters: { stream: false },
            tools: []
          },
          createProfile({ incomingProtocol: 'responses', outgoingProtocol: 'openai-chat' }),
          createContext({ metadata: {} })
        );
        assert.equal(typeof out, 'object');
      });
    }

    {
      const out = await runStandardChatRequestFilters(
        {
          model: 'gpt-x',
          stream: true,
          messages: [{ role: 'user', content: 'ping' }],
          tool_outputs: [{ id: 'x', content: 'y' }],
          tools: []
        },
        createProfile({ incomingProtocol: 'responses', outgoingProtocol: 'openai-chat' }),
        createContext({ metadata: {} })
      );
      assert.equal(out.stream, true);
      assert.equal(Array.isArray(out.messages), true);
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() {',
          '    return JSON.stringify({',
          '      model: "gpt-branch-shape",',
          '      messages: [null, 1, { role: "assistant", tool_calls: [null, { call_id: "legacy_tc", tool_call_id: "drop_me", function: { name: "x", arguments: { y: 1 } } }] }, { role: "tool", call_id: "legacy_tool", id: "tool_msg", content: "done" }],',
          '      stream: false,',
          '      parameters: {},',
          '      metadata: { shouldDrop: true },',
          '      originalStream: false,',
          '      _originalStreamOptions: { include_usage: true },',
          '      __rcc_trace: true',
          '    });',
          '  },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { runStandardChatRequestFilters: runWithBranchShape } = await importFresh('chat-request-filters-coverage-branch-shape');
          const out = await runWithBranchShape(
            {
              model: 'gpt-branch-shape',
              messages: [{ role: 'user', content: 'branch shape' }]
            },
            createProfile(),
            createContext()
          );
          assert.equal(Array.isArray(out.messages), true);
          assert.equal(out.messages[0], null);
          assert.equal(out.messages[1], 1);
          assert.equal(out.messages[2].tool_calls[0], null);
          assert.equal('call_id' in out.messages[2].tool_calls[1], false);
          assert.equal('tool_call_id' in out.messages[2].tool_calls[1], false);
          assert.equal(out.messages[3].tool_call_id, 'legacy_tool');
          assert.equal('id' in out.messages[3], false);
          assert.equal(out.metadata, undefined);
          assert.equal(out.originalStream, undefined);
          assert.equal(out._originalStreamOptions, undefined);
          assert.equal(out.__rcc_trace, undefined);
        }
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() {',
          '    return JSON.stringify({',
          '      model: "claude-native-no-tools",',
          '      messages: [{ role: "user", content: "hi" }],',
          '      stream: false,',
          '      parameters: {}',
          '    });',
          '  },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { runStandardChatRequestFilters: runWithoutTools } = await importFresh('chat-request-filters-coverage-no-tools-payload');
          const out = await runWithoutTools(
            {
              model: 'claude-no-tools',
              messages: [{ role: 'user', content: 'hello' }]
            },
            createProfile({ incomingProtocol: 'anthropic-messages', outgoingProtocol: 'openai-chat' }),
            createContext({ entryEndpoint: '/v1/messages', endpoint: '/v1/messages' })
          );
          assert.equal(Array.isArray(out.tools), true);
        }
      );
    }

    {
      await withRemovedNativeExport('buildGovernedFilterPayloadJson', async () => {
        const { runStandardChatRequestFilters: runWithMissingNative } = await importFresh(
          'chat-request-filters-coverage-missing-native'
        );
        await assert.rejects(
          runWithMissingNative(
            {
              model: 'gpt-x',
              messages: [{ role: 'user', content: 'hello' }]
            },
            createProfile(),
            createContext()
          ),
          /buildGovernedFilterPayloadJson/i
        );
      });
    }

    {
      const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics');

      const parsed = buildGovernedFilterPayloadWithNative({
        model: 'gpt-direct',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        parameters: { temperature: 0.7 }
      });
      assert.equal(parsed.stream, true);
      assert.equal(Array.isArray(parsed.messages), true);

      const circular = {};
      circular.self = circular;
      assert.throws(
        () => buildGovernedFilterPayloadWithNative(circular),
        /json stringify failed/i
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() { return ""; },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics-empty-result');
          assert.throws(
            () => buildGovernedFilterPayloadWithNative({ model: 'x', messages: [] }),
            /empty result/i
          );
        }
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() { return "[1,2]"; },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics-invalid-array');
          assert.throws(
            () => buildGovernedFilterPayloadWithNative({ model: 'x', messages: [] }),
            /invalid payload/i
          );
        }
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() { return "{"; },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics-invalid-json');
          assert.throws(
            () => buildGovernedFilterPayloadWithNative({ model: 'x', messages: [] }),
            /invalid payload/i
          );
        }
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() { throw "mock-throw"; },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics-throw');
          assert.throws(
            () => buildGovernedFilterPayloadWithNative({ model: 'x', messages: [] }),
            /mock-throw/i
          );
        }
      );
    }

    {
      await withTempNativeModule(
        [
          `const real = require(${JSON.stringify(nativeNodePath)});`,
          'module.exports = { ...real,',
          '  buildGovernedFilterPayloadJson() { throw undefined; },',
          '};'
        ].join('\n'),
        async (modulePath) => {
          setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
          const { buildGovernedFilterPayloadWithNative } = await importNativeSemanticsFresh('native-chat-request-filter-semantics-throw-undefined');
          assert.throws(
            () => buildGovernedFilterPayloadWithNative({ model: 'x', messages: [] }),
            /unknown/i
          );
        }
      );
    }
  });

  console.log('✅ coverage-chat-request-filters passed');
}

main().catch((error) => {
  console.error('❌ coverage-chat-request-filters failed:', error);
  process.exit(1);
});
