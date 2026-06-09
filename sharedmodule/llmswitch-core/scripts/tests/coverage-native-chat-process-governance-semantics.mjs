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
    'native',
    'router-hotpath',
    'native-chat-process-governance-semantics.js'
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-native-chat-governance-sem-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  await withTempNativeModule(
    `
exports.governResponseJson = (inputJson) => {
  const input = JSON.parse(inputJson);
  const payload = input && input.payload && typeof input.payload === 'object' ? input.payload : {};
  return JSON.stringify({
    governed_payload: {
      ...payload,
      __native_governed: true
    },
    summary: {
      applied: true,
      tool_calls_normalized: 2,
      apply_patch_repaired: 1
    }
  });
};
exports.finalizeChatResponseJson = (inputJson) => {
  const input = JSON.parse(inputJson);
  const payload = input && input.payload && typeof input.payload === 'object' ? input.payload : {};
  return JSON.stringify({
    finalized_payload: {
      ...payload,
      __native_finalized: true
    }
  });
};
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);

      const mod = await importFresh('native-chat-process-governance-semantics');

      const stage1Governed = mod.applyRespProcessToolGovernanceWithNative(
        {
          payload: {
            choices: [
              {
                message: {
                  tool_calls: [{ id: 'call_1' }]
                }
              }
            ]
          },
          clientProtocol: 'openai-chat',
          entryEndpoint: '/v1/chat/completions',
          requestId: 'req_native_govern_1'
        }
      );
      assert.equal(stage1Governed.governedPayload.__native_governed, true);
      assert.equal(stage1Governed.summary.applied, true);
      assert.equal(stage1Governed.summary.toolCallsNormalized, 2);
      assert.equal(stage1Governed.summary.applyPatchRepaired, 1);

      const finalized = await mod.finalizeRespProcessChatResponseWithNative(
        {
          payload: {
            id: 'chatcmpl-native',
            choices: [{ message: { content: 'ok' } }]
          },
          stream: false,
          reasoningMode: 'keep',
          endpoint: '/v1/chat/completions',
          requestId: 'req_finalize_native_1'
        }
      );
      assert.equal(finalized.__native_finalized, true);
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

  console.log('✅ coverage-native-chat-process-governance-semantics passed');
}

main().catch((error) => {
  console.error('❌ coverage-native-chat-process-governance-semantics failed:', error);
  process.exit(1);
});
