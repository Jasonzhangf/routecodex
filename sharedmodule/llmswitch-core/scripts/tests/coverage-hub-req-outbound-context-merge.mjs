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
    'req_outbound',
    'req_outbound_stage1_semantic_map',
    'context-merge.js'
  )
).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

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

function clearNativeEnv() {
  for (const key of [
    'ROUTECODEX_LLMS_ROUTER_NATIVE_PATH',
    'RCC_LLMS_ROUTER_NATIVE_PATH',
    'ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE',
    'RCC_LLMS_ROUTER_NATIVE_DISABLE'
  ]) {
    delete process.env[key];
  }
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-hub-req-outbound-context-merge-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function workspaceNativeCandidatePaths() {
  const rustCore = path.join(repoRoot, 'rust-core', 'target');
  return [
    path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'release', 'router_hotpath_napi.dll'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.node'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.dll')
  ];
}

async function withWorkspaceNativeMasked(fn) {
  const backups = [];
  for (const candidate of workspaceNativeCandidatePaths()) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const backupPath = `${candidate}.bak.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fs.rename(candidate, backupPath);
    backups.push({ candidate, backupPath });
  }

  try {
    await fn();
  } finally {
    for (const item of backups.reverse()) {
      await fs.rename(item.backupPath, item.candidate);
    }
  }
}

function makeEnvelope() {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    metadata: {}
  };
}

function makeAdapterContext(overrides = {}) {
  return {
    requestId: 'req_ctx_merge',
    providerProtocol: 'openai-responses',
    toolCallIdStyle: 'fc',
    ...overrides
  };
}

function assertNativeUnavailableError(fn, capability) {
  const re = capability
    ? new RegExp(`native ${capability} is required but unavailable`, 'i')
    : /native .* is required but unavailable/i;
  assert.throws(fn, re);
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;

  try {
    await withWorkspaceNativeMasked(async () => {
      clearNativeEnv();
      setEnvVar(
        'ROUTECODEX_LLMS_ROUTER_NATIVE_PATH',
        path.join(os.tmpdir(), `ctx-merge-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.node`)
      );
      const mod = await importFresh('missing-native');
      const { applyContextSnapshotToChatEnvelope, applyToolCallIdStyleMetadata } = mod;

      assertNativeUnavailableError(
        () => applyContextSnapshotToChatEnvelope(makeEnvelope(), { tool_outputs: [{ tool_call_id: 'a', output: 'b' }] }),
        'applyReqOutboundContextSnapshotJson'
      );
      assertNativeUnavailableError(
        () => applyToolCallIdStyleMetadata(makeEnvelope(), makeAdapterContext({ toolCallIdStyle: 'preserve' })),
        'selectToolCallIdStyleJson'
      );
    });

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.selectToolCallIdStyleJson = () => JSON.stringify('preserve');
module.exports.applyReqOutboundContextSnapshotJson = () => JSON.stringify({
  toolOutputs: [
    { tool_call_id: 'native_call_1', content: 'native_output_1', name: 'exec_command' },
    { toolCallId: 'native_call_2', content: 'native_output_2' }
  ],
  tools: [
    null,
    'bad-tool',
    { type: 'other' },
    { type: 'function', function: null },
    { type: 'function', function: { name: 'tool_a', parameters: { type: 'object', properties: {} }, description: 'A', strict: true } },
    { type: 'function', function: { name: '   ', parameters: {} } },
    { type: 'function', function: { name: 'tool_b' } }
  ]
});`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-ok');
        const { applyContextSnapshotToChatEnvelope, applyToolCallIdStyleMetadata } = mod;

        const envelopeStyle = makeEnvelope();
        applyToolCallIdStyleMetadata(envelopeStyle, makeAdapterContext({ toolCallIdStyle: 'fc' }), {
          toolCallIdStyle: 'preserve'
        });
        assert.equal(envelopeStyle.metadata.toolCallIdStyle, 'preserve');
        const envelopeNoMetadata = { messages: [] };
        applyToolCallIdStyleMetadata(envelopeNoMetadata, makeAdapterContext({ toolCallIdStyle: 'fc' }), {
          toolCallIdStyle: 'preserve'
        });
        assert.equal(envelopeNoMetadata.metadata.toolCallIdStyle, 'preserve');
        assert.equal(typeof envelopeNoMetadata.metadata.context, 'object');
        const envelopeSameStyle = makeEnvelope();
        envelopeSameStyle.metadata.toolCallIdStyle = 'preserve';
        applyToolCallIdStyleMetadata(envelopeSameStyle, makeAdapterContext({ toolCallIdStyle: 'fc' }), {
          toolCallIdStyle: 'preserve'
        });
        assert.equal(envelopeSameStyle.metadata.toolCallIdStyle, 'preserve');

        const envelope = makeEnvelope();
        applyContextSnapshotToChatEnvelope(envelope, {
          tool_outputs: [{ tool_call_id: 'ts_call', output: 'ts_output' }],
          tools: []
        });
        assert.equal(Array.isArray(envelope.toolOutputs), true);
        assert.equal(envelope.toolOutputs.length, 2);
        assert.equal(envelope.toolOutputs[0].tool_call_id, 'native_call_1');
        assert.equal(envelope.toolOutputs[1].tool_call_id, 'native_call_2');
        assert.equal(envelope.toolOutputs[0].name, 'exec_command');

        assert.equal(Array.isArray(envelope.tools), true);
        assert.equal(envelope.tools.length, 2);
        assert.equal(envelope.tools[0].function.name, 'tool_a');
        assert.equal(envelope.tools[0].function.strict, true);
        assert.equal(envelope.tools[1].function.name, 'tool_b');
        assert.deepEqual(envelope.tools[1].function.parameters, { type: 'object', properties: {} });
        const existingOutputEnvelope = makeEnvelope();
        existingOutputEnvelope.toolOutputs = [{ tool_call_id: 'existing_call', content: 'existing_output' }];
        applyContextSnapshotToChatEnvelope(existingOutputEnvelope, { tool_outputs: [] });
        assert.equal(existingOutputEnvelope.toolOutputs.length, 2);
        assert.equal(existingOutputEnvelope.toolOutputs[0].tool_call_id, 'native_call_1');

        const existingToolsEnvelope = makeEnvelope();
        existingToolsEnvelope.tools = [
          {
            type: 'function',
            function: { name: 'existing_tool', parameters: { type: 'object', properties: {} } }
          }
        ];
        applyContextSnapshotToChatEnvelope(existingToolsEnvelope, { tool_outputs: [] });
        assert.equal(existingToolsEnvelope.tools.length, 1);
        assert.equal(existingToolsEnvelope.tools[0].function.name, 'existing_tool');
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.applyReqOutboundContextSnapshotJson = () => JSON.stringify({});`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-empty-plan');
        const envelope = makeEnvelope();
        mod.applyContextSnapshotToChatEnvelope(envelope, { tool_outputs: [] });
        assert.equal(envelope.toolOutputs, undefined);
        assert.equal(envelope.tools, undefined);
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.applyReqOutboundContextSnapshotJson = () => JSON.stringify([]);`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-invalid-payload');
        assertNativeUnavailableError(
          () => mod.applyContextSnapshotToChatEnvelope(makeEnvelope(), { tool_outputs: [] }),
          'applyReqOutboundContextSnapshotJson'
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.selectToolCallIdStyleJson = () => JSON.stringify('invalid');`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-style-invalid');
        assertNativeUnavailableError(
          () => mod.applyToolCallIdStyleMetadata(makeEnvelope(), makeAdapterContext({ toolCallIdStyle: 'fc' })),
          'selectToolCallIdStyleJson'
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.selectToolCallIdStyleJson = () => JSON.stringify(null);`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-style-empty');
        const envelope = makeEnvelope();
        mod.applyToolCallIdStyleMetadata(envelope, makeAdapterContext({ toolCallIdStyle: 'fc' }));
        assert.equal(envelope.metadata.toolCallIdStyle, undefined);
      }
    );

    console.log('✅ coverage-hub-req-outbound-context-merge passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
    if (prevNativeDisable === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-outbound-context-merge failed:', error);
  process.exit(1);
});
