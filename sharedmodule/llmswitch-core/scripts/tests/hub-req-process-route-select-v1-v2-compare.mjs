#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');
const targetUtilsModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'pipeline', 'target-utils.js')
).href;
const nativeSemanticsModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-req-process-semantics.js'
  )
).href;

function importFresh(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefined(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    output[key] = pruneUndefined(item);
  }
  return output;
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

function buildCases() {
  return [
    {
      id: 'full-target-model-id',
      request: {
        model: 'client-model',
        parameters: { model: 'client-model', keep: 1 },
        metadata: { existing: true }
      },
      normalizedMetadata: {
        existingNorm: true
      },
      target: {
        providerKey: 'iflow.kimi-k2.5',
        providerType: 'openai-responses',
        modelId: 'kimi-k2.5',
        processMode: 'chat',
        responsesConfig: { toolCallIdStyle: 'fc' },
        forceWebSearch: true,
        forceVision: true,
        streaming: 'sse'
      },
      routeName: 'thinking-primary',
      originalModel: 'client-model'
    },
    {
      id: 'runtime-prefix-model-derive',
      request: {
        model: 'legacy-model',
        parameters: {},
        metadata: {}
      },
      normalizedMetadata: {},
      target: {
        providerKey: 'tabglm.glm-5',
        runtimeKey: 'tabglm',
        providerType: 'openai-chat',
        processMode: 'chat',
        responsesConfig: { toolCallIdStyle: 'preserve' }
      },
      routeName: 'default-primary',
      originalModel: 'legacy-model'
    },
    {
      id: 'keep-existing-original-model-id',
      request: {
        model: 'origin-model',
        metadata: {
          originalModelId: 'already-set',
          clientModelId: 'already-set'
        }
      },
      normalizedMetadata: {
        originalModelId: 'already-set-norm',
        clientModelId: 'already-set-norm'
      },
      target: {
        providerKey: 'qwen.qwen3.5-plus',
        providerType: 'openai-responses',
        processMode: 'chat'
      },
      routeName: 'longcontext-primary',
      originalModel: 'origin-model'
    }
  ];
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  try {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', nativeNodePath);
    setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');

    const targetUtils = await importFresh(targetUtilsModuleUrl, 'target-utils');
    const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'native-semantics');

    for (const testCase of buildCases()) {
      const expectedRequest = cloneJson(testCase.request);
      const expectedMetadata = cloneJson(testCase.normalizedMetadata);

      targetUtils.applyTargetMetadata(expectedMetadata, cloneJson(testCase.target), testCase.routeName, testCase.originalModel);
      targetUtils.applyTargetToSubject(expectedRequest, cloneJson(testCase.target), testCase.originalModel);

      const output = nativeSemantics.applyReqProcessRouteSelectionWithNative(
        {
          request: cloneJson(testCase.request),
          normalizedMetadata: cloneJson(testCase.normalizedMetadata),
          target: cloneJson(testCase.target),
          routeName: testCase.routeName,
          originalModel: testCase.originalModel
        }
      );
      assert.deepEqual(
        pruneUndefined(output.request),
        pruneUndefined(expectedRequest),
        `${testCase.id}: request mismatch`
      );
      assert.deepEqual(
        pruneUndefined(output.normalizedMetadata),
        pruneUndefined(expectedMetadata),
        `${testCase.id}: metadata mismatch`
      );
    }
  } finally {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', prevNativePath);
    setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', prevRccNativePath);
  }

  console.log('✅ hub-req-process-route-select-v1-v2-compare passed');
}

main().catch((error) => {
  console.error('❌ hub-req-process-route-select-v1-v2-compare failed:', error);
  process.exit(1);
});
