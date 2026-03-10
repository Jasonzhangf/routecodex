#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-governance-orchestration.js')
).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-governance-native-'));
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

function createMockNativeModuleSource(resultPayload) {
  const raw = JSON.stringify(resultPayload);
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = { ...real,',
    `  applyReqProcessToolGovernanceJson() { return ${JSON.stringify(raw)}; },`,
    '};'
  ].join('\n');
}

function makeRequest(overrides = {}) {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' },
    ...overrides
  };
}

function makeContext(overrides = {}) {
  return {
    entryEndpoint: '/v1/chat/completions',
    requestId: 'req-test',
    metadata: {},
    ...overrides
  };
}

async function main() {
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const { applyRequestToolGovernance } = await importFresh('hub-chat-process-governance-orchestration');
  assert.equal(typeof applyRequestToolGovernance, 'function');

  {
    const request = makeRequest();
    const out = await applyRequestToolGovernance(
      request,
      makeContext(),
      {
        governRequest(req) {
          return { request: req, summary: { applied: false } };
        }
      }
    );
    assert.equal(out.model, 'gpt-test');
    assert.equal(Array.isArray(out.messages), true);
    assert.equal(out.metadata.toolGovernance, undefined);
  }

  {
    const request = makeRequest({ metadata: /** @type {any} */ ({}) });
    const out = await applyRequestToolGovernance(
      request,
      makeContext({ entryEndpoint: '', metadata: { providerProtocol: 'openai-chat', stream: true } }),
      {
        governRequest(req) {
          return { request: req, summary: { applied: true, patched: 1 } };
        }
      }
    );
    assert.equal(out.metadata.toolGovernance.request.applied, true);
    assert.equal(out.metadata.toolGovernance.request.patched, 1);
  }

  {
    const request = makeRequest({ metadata: { originalEndpoint: '/v1/chat/completions' } });
    const out = await applyRequestToolGovernance(
      request,
      makeContext({ entryEndpoint: '/v1/messages', metadata: { provider: 'anthropic-chat' } })
    );
    assert.equal(out.model, 'gpt-test');
  }

  {
    await assert.rejects(
      applyRequestToolGovernance(
        /** @type {any} */ (null),
        makeContext()
      ),
      /chat governance input request is invalid/i
    );
  }

  await withTempNativeModule(
    createMockNativeModuleSource({
      processedRequest: { model: 'x', metadata: {}, parameters: {} },
      nodeResult: { success: true }
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { applyRequestToolGovernance: applyWithMock } = await importFresh(
        'hub-chat-process-governance-orchestration-invalid-native-messages'
      );
      await assert.rejects(
        applyWithMock(makeRequest(), makeContext()),
        /native chat governance returned malformed request envelope/i
      );
    }
  );

  await withTempNativeModule(
    createMockNativeModuleSource({
      processedRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'ok' }] },
      nodeResult: { success: true }
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const { applyRequestToolGovernance: applyWithMock } = await importFresh(
        'hub-chat-process-governance-orchestration-missing-meta-params'
      );
      const out = await applyWithMock(makeRequest(), makeContext());
      assert.equal(typeof out.parameters, 'object');
      assert.equal(typeof out.metadata, 'object');
    }
  );

  {
    let seenProtocol = '';
    const out = await applyRequestToolGovernance(
      makeRequest(),
      makeContext({ entryEndpoint: '/v1/messages', metadata: {} }),
      {
        governRequest(req, providerProtocol) {
          seenProtocol = providerProtocol;
          return { request: req, summary: { applied: false } };
        }
      }
    );
    assert.equal(out.model, 'gpt-test');
    assert.equal(seenProtocol, 'anthropic-chat');
  }

  console.log('✅ coverage-hub-chat-process-governance-orchestration passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-governance-orchestration failed:', error);
  process.exit(1);
});
