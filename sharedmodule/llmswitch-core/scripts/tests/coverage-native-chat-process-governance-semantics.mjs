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
    'router',
    'virtual-router',
    'engine-selection',
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
exports.resolveGovernanceContextJson = () => JSON.stringify({
  entryEndpoint: '/v1/responses',
  metadata: { providerProtocol: 'openai-responses' },
  providerProtocol: 'openai-responses',
  metadataToolHints: { fromNative: true },
  inboundStreamIntent: true,
  rawRequestBody: { fromNative: true }
});
exports.applyGovernedControlOperationsJson = (requestJson) => {
  const request = JSON.parse(requestJson);
  return JSON.stringify({
    ...request,
    metadata: { ...(request.metadata || {}), inboundStream: true, __nativeApplied: true },
    parameters: { ...(request.parameters || {}), stream: false, tool_choice: { type: 'function' } },
    model: 'gpt-native'
  });
};
exports.applyGovernedMergeRequestJson = (requestJson) => {
  const request = JSON.parse(requestJson);
  return JSON.stringify({
    ...request,
    messages: [{ role: 'assistant', content: 'native merge applied' }],
    parameters: { ...(request.parameters || {}), top_p: 0.8 },
    metadata: {
      ...(request.metadata || {}),
      toolChoice: 'auto',
      originalStream: false,
      stream: false,
      providerStream: true,
      governedTools: true,
      governanceTimestamp: 1700000000000
    }
  });
};
exports.mergeGovernanceSummaryIntoMetadataJson = () => JSON.stringify({
  originalEndpoint: '/v1/chat/completions',
  toolGovernance: { previous: true, request: { applied: true, patched: 2 } }
});
exports.finalizeGovernedRequestJson = (requestJson) => {
  const request = JSON.parse(requestJson);
  return JSON.stringify({
    ...request,
    metadata: {
      ...(request.metadata || {}),
      __nativeFinalize: true
    }
  });
};
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

      let governanceFallbackExecuted = false;
      const governanceContext = mod.resolveGovernanceContextWithNative(
        { model: 'gpt-base', parameters: { stream: true } },
        { entryEndpoint: '/v1/chat/completions', metadata: { providerProtocol: 'openai-chat' } },
        () => {
          governanceFallbackExecuted = true;
          return {
            entryEndpoint: '/v1/chat/completions',
            metadata: { providerProtocol: 'openai-chat' },
            providerProtocol: 'openai-chat',
            metadataToolHints: undefined,
            inboundStreamIntent: false
          };
        }
      );
      assert.equal(governanceFallbackExecuted, false);
      assert.equal(governanceContext.providerProtocol, 'openai-responses');
      assert.equal(governanceContext.inboundStreamIntent, true);
      assert.equal(governanceContext.rawRequestBody.fromNative, true);

      const controlled = mod.applyGovernedControlOperationsWithNative(
        {
          model: 'gpt-base',
          metadata: { originalEndpoint: '/v1/chat/completions' },
          parameters: { stream: true }
        },
        { stream: false },
        true
      );
      assert.equal(controlled.metadata.__nativeApplied, true);
      assert.equal(controlled.metadata.inboundStream, true);
      assert.equal(controlled.parameters.stream, false);
      assert.equal(controlled.parameters.tool_choice.type, 'function');
      assert.equal(controlled.model, 'gpt-native');

      const mergedRequest = mod.applyGovernedMergeRequestWithNative(
        {
          model: 'gpt-base',
          messages: [{ role: 'user', content: 'hi' }],
          parameters: { stream: true },
          metadata: { originalEndpoint: '/v1/chat/completions' }
        },
        { stream: false },
        false,
        1700000000000
      );
      assert.equal(Array.isArray(mergedRequest.messages), true);
      assert.equal(mergedRequest.messages[0].content, 'native merge applied');
      assert.equal(mergedRequest.parameters.top_p, 0.8);
      assert.equal(mergedRequest.metadata.toolChoice, 'auto');
      assert.equal(mergedRequest.metadata.providerStream, true);

      const mergedMetadata = mod.mergeGovernanceSummaryIntoMetadataWithNative(
        { originalEndpoint: '/v1/chat/completions', toolGovernance: { previous: true } },
        { applied: true, patched: 2 }
      );
      assert.equal(mergedMetadata.originalEndpoint, '/v1/chat/completions');
      assert.equal(mergedMetadata.toolGovernance.previous, true);
      assert.equal(mergedMetadata.toolGovernance.request.applied, true);
      assert.equal(mergedMetadata.toolGovernance.request.patched, 2);

      const finalizedGovernedRequest = mod.finalizeGovernedRequestWithNative(
        {
          model: 'gpt-base',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { originalEndpoint: '/v1/chat/completions' }
        },
        { applied: true, patched: 2 }
      );
      assert.equal(finalizedGovernedRequest.metadata.__nativeFinalize, true);

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
