#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatProcessModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process.js')
).href;
const clientInjectModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'client-inject-readiness.js')
).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

function setEnvVar(key, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importModules(tag) {
  const [chatProcessMod, clientInjectMod] = await Promise.all([
    cacheBustedImport(chatProcessModuleUrl, `${tag}_chat`),
    cacheBustedImport(clientInjectModuleUrl, `${tag}_inject`)
  ]);
  return { chatProcessMod, clientInjectMod };
}

async function withTempNativeModule(content, run) {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-chat-entry-native-'));
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

function createRequest() {
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      }
    ],
    tools: [],
    metadata: {}
  };
}

function createMockNativeModuleSource({
  shouldRun = false,
  clientInjectReady = true,
  throwInShouldRun = false,
  shouldRunRaw = null,
  clientInjectRaw = null
} = {}) {
  const shouldRunImpl = throwInShouldRun
    ? 'throw new Error("should-run-failed");'
    : `return ${JSON.stringify(shouldRunRaw ?? JSON.stringify(Boolean(shouldRun)))};`;
  const clientInjectImpl = `return ${JSON.stringify(clientInjectRaw ?? JSON.stringify(Boolean(clientInjectReady)))};`;

  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = { ...real,',
    `  shouldRunHubChatProcessJson() { ${shouldRunImpl} },`,
    `  resolveClientInjectReadyJson() { ${clientInjectImpl} },`,
    '};'
  ].join('\n');
}

async function runCoverage() {
  // Baseline with real native binding.
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  {
    const { chatProcessMod, clientInjectMod } = await importModules('baseline');
    const { runHubChatProcess } = chatProcessMod;
    const { isClientInjectReady } = clientInjectMod;

    assert.equal(isClientInjectReady({}), true);
    assert.equal(isClientInjectReady({ clientInjectReady: false }), false);
    assert.equal(isClientInjectReady({ client_inject_ready: 'true' }), true);
    assert.equal(isClientInjectReady({ clientInjectReady: 'false' }), false);
    assert.equal(isClientInjectReady({ clientInjectReady: 'invalid' }), true);

    const result = await runHubChatProcess({
      request: createRequest(),
      requestId: 'req-baseline',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {}
    });
    assert.equal(result.nodeResult.success, true);
    assert.equal(typeof result.nodeResult.metadata.executionTime, 'number');
  }

  // Native: governance disabled path + explicit client inject false.
  await withTempNativeModule(
    createMockNativeModuleSource({ shouldRun: false, clientInjectReady: false }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { chatProcessMod, clientInjectMod } = await importModules('native-disabled-governance');
      const { runHubChatProcess } = chatProcessMod;
      const { isClientInjectReady } = clientInjectMod;

      assert.equal(isClientInjectReady({ clientInjectReady: true }), false);

      const result = await runHubChatProcess({
        request: createRequest(),
        requestId: 'req-native-false',
        entryEndpoint: '/v1/chat/completions',
        rawPayload: {},
        metadata: {}
      });
      assert.equal(result.nodeResult.success, true);
      assert.ok(result.processedRequest);
    }
  );

  // Native: governance enabled path causes runtime error, should be caught as error result.
  await withTempNativeModule(
    createMockNativeModuleSource({ shouldRun: true, clientInjectReady: true }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { chatProcessMod, clientInjectMod } = await importModules('native-governance-error');
      const { runHubChatProcess } = chatProcessMod;
      const { isClientInjectReady } = clientInjectMod;

      assert.equal(isClientInjectReady({ clientInjectReady: false }), true);

      const result = await runHubChatProcess({
        request: null,
        requestId: 'req-native-true',
        entryEndpoint: '/v1/chat/completions',
        rawPayload: {},
        metadata: {}
      });
      assert.equal(result.nodeResult.success, false);
      assert.equal(typeof result.nodeResult.error?.message, 'string');
      assert.ok(result.nodeResult.error?.message.length > 0);
    }
  );

  // Native: malformed payload from shouldRun / clientInject should fail fast.
  await withTempNativeModule(
    createMockNativeModuleSource({ shouldRunRaw: '"not-bool"', clientInjectRaw: '"not-bool"' }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { chatProcessMod, clientInjectMod } = await importModules('native-invalid-payload');
      const { runHubChatProcess } = chatProcessMod;
      const { isClientInjectReady } = clientInjectMod;

      assert.throws(
        () => isClientInjectReady({}),
        /native resolveClientInjectReadyJson is required but unavailable: invalid payload/i
      );

      const result = await runHubChatProcess({
        request: createRequest(),
        requestId: 'req-native-invalid',
        entryEndpoint: '/v1/chat/completions',
        rawPayload: {},
        metadata: {}
      });
      assert.equal(result.nodeResult.success, false);
      assert.match(
        result.nodeResult.error?.message ?? '',
        /native shouldRunHubChatProcessJson is required but unavailable: invalid payload/i
      );
    }
  );

  // Native: shouldRun throws non-empty error reason, should map into node error.
  await withTempNativeModule(
    createMockNativeModuleSource({ throwInShouldRun: true, clientInjectReady: true }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { chatProcessMod } = await importModules('native-throw');
      const { runHubChatProcess } = chatProcessMod;

      const result = await runHubChatProcess({
        request: createRequest(),
        requestId: 'req-native-throw',
        entryEndpoint: '/v1/chat/completions',
        rawPayload: {},
        metadata: {}
      });
      assert.equal(result.nodeResult.success, false);
      assert.match(result.nodeResult.error?.message ?? '', /should-run-failed/i);
    }
  );
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  try {
    await runCoverage();
    console.log('✅ coverage-hub-chat-process-entry-client-inject passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-entry-client-inject failed:', error);
  process.exit(1);
});
