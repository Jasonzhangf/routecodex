#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governance-context.js')
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-chat-governance-context-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeRequest(stream = false) {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: { stream },
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const { resolveGovernanceContext } = await importFresh('hub-chat-process-governance-context');
  assert.equal(typeof resolveGovernanceContext, 'function');

  {
    const out = resolveGovernanceContext(makeRequest(false), {
      entryEndpoint: '  /v1/messages  ',
      metadata: {
        providerProtocol: ' anthropic-chat ',
        stream: true,
        toolFilterHints: { mode: 'strict' },
        __raw_request_body: { x: 1 }
      }
    });
    assert.equal(out.entryEndpoint, '  /v1/messages  ');
    assert.equal(out.providerProtocol, 'anthropic-chat');
    assert.equal(out.inboundStreamIntent, true);
    assert.equal(out.metadataToolHints.mode, 'strict');
    assert.equal(out.rawRequestBody.x, 1);
  }

  {
    const out = resolveGovernanceContext(makeRequest(true), {
      entryEndpoint: '',
      metadata: {
        provider: ' openai-chat ',
        stream: 'bad',
        __raw_request_body: 'nope'
      }
    });
    assert.equal(out.entryEndpoint, '/v1/chat/completions');
    assert.equal(out.providerProtocol, 'openai-chat');
    assert.equal(out.inboundStreamIntent, true);
    assert.equal(out.rawRequestBody, undefined);
  }

  {
    const out = resolveGovernanceContext(makeRequest(false), {
      entryEndpoint: '',
      metadata: /** @type {any} */ (null)
    });
    assert.equal(out.providerProtocol, 'openai-chat');
    assert.equal(out.inboundStreamIntent, false);
    assert.deepEqual(out.metadata, {});
  }

  await withTempNativeModule(
    `
exports.resolveGovernanceContextJson = () => JSON.stringify({
  entryEndpoint: '/native/messages',
  metadata: { fromNative: true },
  providerProtocol: 'native-protocol',
  metadataToolHints: { mode: 'native' },
  inboundStreamIntent: true,
  rawRequestBody: { native: 1 }
});
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-governance-context-native');
      const out = modNative.resolveGovernanceContext(makeRequest(false), {
        entryEndpoint: '/v1/messages',
        metadata: {}
      });
      assert.equal(out.entryEndpoint, '/native/messages');
      assert.equal(out.providerProtocol, 'native-protocol');
      assert.equal(out.metadata.fromNative, true);
      assert.deepEqual(out.metadataToolHints, { mode: 'native' });
      assert.deepEqual(out.rawRequestBody, { native: 1 });
      assert.equal(out.inboundStreamIntent, true);
    }
  );

  if (prevNativeDisable === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
  }
  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-governance-context passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governance-context failed:', error);
  process.exit(1);
});
