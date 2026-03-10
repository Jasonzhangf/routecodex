#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stage2ModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_process',
    'req_process_stage2_route_select',
    'index.js'
  )
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
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

function importFresh(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-hub-req-process-route-select-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildRouteResult(overrides = {}) {
  const target = {
    providerKey: 'iflow.kimi-k2.5',
    providerType: 'openai-responses',
    modelId: 'kimi-k2.5',
    processMode: 'chat',
    runtimeKey: 'iflow',
    responsesConfig: { toolCallIdStyle: 'fc' },
    ...overrides.target
  };
  return {
    target,
    decision: {
      routeName: 'thinking-primary',
      ...overrides.decision
    },
    diagnostics: {
      strategy: 'unit-test',
      ...overrides.diagnostics
    }
  };
}

function buildStageRecorder(bucket) {
  return {
    record(stageId, payload) {
      bucket.push({ stageId, payload });
    }
  };
}

function buildStage2Options(overrides = {}) {
  const routeResult = buildRouteResult(overrides.routeResult ?? {});
  const request = {
    model: 'gpt-client',
    parameters: { model: 'gpt-client', keep: 'keep' },
    metadata: { preserve: true },
    messages: [{ role: 'user', content: 'hello' }],
    staleField: 'drop-me',
    ...(overrides.request ?? {})
  };
  const normalizedMetadata = {
    extra: 'drop-me',
    ...((overrides.normalizedMetadata ?? {}))
  };
  return {
    routerEngine: {
      route() {
        return routeResult;
      }
    },
    request,
    metadataInput: { requestId: 'req_route_select_cov' },
    normalizedMetadata,
    stageRecorder: buildStageRecorder(overrides.stageRecords ?? [])
  };
}

function assertNativeRequiredError(error, reasonPart, capability = 'applyReqProcessRouteSelectionJson') {
  assert.equal(error instanceof Error, true);
  assert.match(error.message, new RegExp(`native ${capability} is required but unavailable`, 'i'));
  if (reasonPart) {
    assert.match(error.message, new RegExp(reasonPart, 'i'));
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  try {
    await withTempNativeModule(
      'module.exports = {};',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'missing-native-fn');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error);
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => "" };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'empty-native-result');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'empty result');
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => "{" };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'invalid-json-payload');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'invalid payload');
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: 1, normalizedMetadata: {} }) };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'invalid-typed-payload');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'invalid payload');
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => JSON.stringify([]) };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'invalid-array-payload');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'invalid payload');
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: [] }) };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'invalid-metadata-payload');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'invalid payload');
          return true;
        });
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => { throw new Error("mock failure"); } };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'native-throws');
        assert.throws(() => mod.runReqProcessStage2RouteSelect(buildStage2Options()), (error) => {
          assertNativeRequiredError(error, 'mock failure');
          return true;
        });
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({
    request: {
      model: 'native-final-model',
      parameters: { model: 'native-final-model', fromNative: true },
      metadata: { assignedModelId: 'native-final-model', fromNative: true }
    },
    normalizedMetadata: {
      providerKey: 'iflow.native-model',
      pipelineId: 'iflow.native-model',
      processMode: 'chat',
      fromNative: true
    }
  })
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'native-success-replace');

        const stageRecords = [];
        const options = buildStage2Options({ stageRecords });
        const result = mod.runReqProcessStage2RouteSelect(options);

        assert.equal(result.target.providerKey, 'iflow.kimi-k2.5');
        assert.equal(options.request.model, 'native-final-model');
        assert.equal(options.request.parameters.model, 'native-final-model');
        assert.equal(options.request.parameters.fromNative, true);
        assert.equal(options.request.metadata.fromNative, true);
        assert.equal('staleField' in options.request, false);

        assert.equal(options.normalizedMetadata.providerKey, 'iflow.native-model');
        assert.equal(options.normalizedMetadata.fromNative, true);
        assert.equal('extra' in options.normalizedMetadata, false);

        assert.equal(stageRecords.length, 1);
        assert.equal(stageRecords[0].stageId, 'chat_process.req.stage5.route_select');
        assert.equal(stageRecords[0].payload.decision.routeName, 'thinking-primary');
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({
    request: {
      metadata: { originalEndpoint: '/v1/chat/completions', fromNative: true },
      parameters: { model: 'from-native-branch' }
    },
    normalizedMetadata: {
      routeName: 'thinking-primary',
      providerKey: 'iflow.kimi-k2.5'
    }
  })
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const mod = await importFresh(stage2ModuleUrl, 'native-success-no-model-string');
        const stageRecords = [];
        const options = buildStage2Options({
          stageRecords,
          request: { model: 123, staleField: undefined },
          normalizedMetadata: { routeName: 'thinking-primary' }
        });
        mod.runReqProcessStage2RouteSelect(options);
        assert.equal(typeof options.request.model, 'undefined');
        assert.equal(options.request.metadata.fromNative, true);
        assert.equal(options.normalizedMetadata.routeName, 'thinking-primary');
        assert.equal(stageRecords.length, 1);
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: (inputJson) => inputJson
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'stringify-failure');
        const circular = {};
        circular.self = circular;
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessRouteSelectionWithNative(
              {
                request: circular,
                normalizedMetadata: {},
                target: {},
                routeName: 'x',
                originalModel: 'y'
              }
            ),
          (error) => {
            assertNativeRequiredError(error, 'json stringify failed');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      'module.exports = { applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }) };',
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'missing-governance-and-hubops');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-missing'
            }),
          (error) => {
            assertNativeRequiredError(error, undefined, 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative({}, []),
          (error) => {
            assertNativeRequiredError(error, undefined, 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => "",
  applyHubOperationsJson: () => ""
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'empty-governance-and-hubops');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-empty'
            }),
          (error) => {
            assertNativeRequiredError(error, 'empty result', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative({}, []),
          (error) => {
            assertNativeRequiredError(error, 'empty result', 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => JSON.stringify({ processedRequest: 1, nodeResult: {} }),
  applyHubOperationsJson: () => JSON.stringify([])
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'invalid-governance-and-hubops');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-invalid'
            }),
          (error) => {
            assertNativeRequiredError(error, 'invalid payload', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative({}, []),
          (error) => {
            assertNativeRequiredError(error, 'invalid payload', 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => "{"
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'invalid-json-governance');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-invalid-json'
            }),
          (error) => {
            assertNativeRequiredError(error, 'invalid payload', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => JSON.stringify({ processedRequest: {}, nodeResult: [] })
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'invalid-node-result-governance');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-invalid-node-result'
            }),
          (error) => {
            assertNativeRequiredError(error, 'invalid payload', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => JSON.stringify({
    processedRequest: { fromNative: true },
    nodeResult: { ok: true, source: 'native' }
  }),
  applyHubOperationsJson: (requestJson, operationsJson) => JSON.stringify({
    request: JSON.parse(requestJson),
    operationCount: JSON.parse(operationsJson).length,
    fromNative: true
  })
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'success-governance-and-hubops');
        const governed = nativeSemantics.applyReqProcessToolGovernanceWithNative({
          request: { hello: 'world' },
          rawPayload: { raw: true },
          metadata: { m: 1 },
          entryEndpoint: '/v1/chat/completions',
          requestId: 'req-gov-success'
        });
        assert.equal(governed.processedRequest.fromNative, true);
        assert.equal(governed.nodeResult.ok, true);

        const applied = nativeSemantics.applyHubOperationsWithNative(
          { model: 'gpt-test' },
          [{ op: 'set', key: 'x' }, { op: 'append', key: 'y' }]
        );
        assert.equal(applied.fromNative, true);
        assert.equal(applied.operationCount, 2);

        const circular = {};
        circular.self = circular;
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: circular,
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-circular'
            }),
          (error) => {
            assertNativeRequiredError(error, 'json stringify failed', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative(circular, []),
          (error) => {
            assertNativeRequiredError(error, 'json stringify failed', 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => JSON.stringify({ processedRequest: {}, nodeResult: {} }),
  applyHubOperationsJson: () => "{"
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'invalid-json-hubops');
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative({}, []),
          (error) => {
            assertNativeRequiredError(error, 'invalid payload', 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = {
  ...real,
  applyReqProcessRouteSelectionJson: () => JSON.stringify({ request: {}, normalizedMetadata: {} }),
  applyReqProcessToolGovernanceJson: () => { throw null; },
  applyHubOperationsJson: () => { throw null; }
};`,
      async (modulePath) => {
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', '');
        const nativeSemantics = await importFresh(nativeSemanticsModuleUrl, 'throw-null-governance-and-hubops');
        assert.throws(
          () =>
            nativeSemantics.applyReqProcessToolGovernanceWithNative({
              request: {},
              rawPayload: {},
              metadata: {},
              entryEndpoint: '/v1/chat/completions',
              requestId: 'req-gov-throw-null'
            }),
          (error) => {
            assertNativeRequiredError(error, 'unknown', 'applyReqProcessToolGovernanceJson');
            return true;
          }
        );
        assert.throws(
          () => nativeSemantics.applyHubOperationsWithNative({}, []),
          (error) => {
            assertNativeRequiredError(error, 'unknown', 'applyHubOperationsJson');
            return true;
          }
        );
      }
    );
  } finally {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', prevNativePath);
    setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', prevRccNativePath);
  }

  console.log('✅ coverage-hub-req-process-route-select passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-process-route-select failed:', error);
  process.exit(1);
});
