#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-node-result.js')
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-node-result-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeRequest(overrides = {}) {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: { stream: false },
    metadata: { originalEndpoint: '/v1/chat/completions' },
    ...overrides
  };
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  const mod = await importFresh('hub-chat-process-node-result');
  assert.equal(typeof mod.buildProcessedRequest, 'function');
  assert.equal(typeof mod.buildSuccessResult, 'function');
  assert.equal(typeof mod.buildErrorResult, 'function');

  {
    const source = makeRequest({
      parameters: { stream: true },
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        capturedContext: { foo: 'bar' }
      },
      tools: [{ type: 'function', function: { name: 'a', parameters: {} } }]
    });
    const out = mod.buildProcessedRequest(source);
    assert.equal(out.processed.status, 'success');
    assert.deepEqual(out.processed.appliedRules, ['tool-governance']);
    assert.equal(out.processingMetadata.streaming.enabled, true);
    assert.equal(out.processingMetadata.streaming.chunkCount, 0);
    assert.deepEqual(out.processingMetadata.context, { foo: 'bar' });

    source.metadata.capturedContext.foo = 'changed';
    assert.equal(out.processingMetadata.context.foo, 'bar');

    const success = mod.buildSuccessResult(Date.now() - 3, out);
    assert.equal(success.success, true);
    assert.equal(success.metadata.node, 'hub-chat-process');
    assert.equal(success.metadata.dataProcessed.messages, 1);
    assert.equal(success.metadata.dataProcessed.tools, 1);
    assert.ok(success.metadata.executionTime >= 0);
  }

  {
    const out = mod.buildProcessedRequest(
      makeRequest({ metadata: { originalEndpoint: '/v1/chat/completions', capturedContext: 'invalid' } })
    );
    assert.equal(out.processingMetadata.streaming.enabled, false);
    assert.equal(out.processingMetadata.context, undefined);
  }

  {
    const out = mod.buildProcessedRequest(makeRequest({ metadata: /** @type {any} */ (null) }));
    assert.equal(out.processingMetadata.context, undefined);

    const err1 = mod.buildErrorResult(Date.now() - 2, new Error('boom'));
    assert.equal(err1.success, false);
    assert.equal(err1.error.message, 'boom');
    assert.equal(err1.metadata.node, 'hub-chat-process');

    const err2 = mod.buildErrorResult(Date.now() - 2, 42);
    assert.equal(err2.error.message, '42');
  }

  {
    const processed = mod.buildProcessedRequest(makeRequest());
    const success = mod.buildSuccessResult(Date.now() - 1, processed);
    assert.equal(success.metadata.dataProcessed.tools, 0);
  }

  await withTempNativeModule(
    `
exports.applyChatProcessedRequestJson = (requestJson, timestampMs) => {
  global.__nodeResultApplyCalled = (global.__nodeResultApplyCalled || 0) + 1;
  const request = JSON.parse(requestJson);
  return JSON.stringify({
    ...request,
    processed: {
      timestamp: Math.floor(Number.isFinite(timestampMs) ? timestampMs : Date.now()),
      appliedRules: ['tool-governance'],
      status: 'success'
    },
    processingMetadata: {
      streaming: { enabled: true, chunkCount: 0 },
      context: { fromNative: true }
    }
  });
};
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);
      global.__nodeResultApplyCalled = 0;
      const modNative = await importFresh('hub-chat-process-node-result-native-apply');
      const out = modNative.buildProcessedRequest(
        makeRequest({
          parameters: { stream: true }
        })
      );
      assert.equal(global.__nodeResultApplyCalled, 1);
      assert.equal(out.processingMetadata.context.fromNative, true);
      assert.equal(out.processingMetadata.streaming.enabled, true);
    }
  );

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }
  if (prevRccNativePath === undefined) {
    delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.RCC_LLMS_ROUTER_NATIVE_PATH = prevRccNativePath;
  }

  console.log('✅ coverage-hub-chat-process-node-result passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-node-result failed:', error);
  process.exit(1);
});
