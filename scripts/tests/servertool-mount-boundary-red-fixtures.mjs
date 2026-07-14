import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyServertoolMountBoundary } from '../architecture/verify-servertool-mount-boundary.mjs';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'routecodex-servertool-mount-boundary-')
);

const paths = {
  engine:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
  requestOwner:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs',
  hookRuntime:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_hook_runtime.rs',
  hookRegistry:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_hook_registry.rs',
  stoplessHook:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_stopless_hook.rs',
  standardizedRequest:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs',
  inboundNormalizer:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs',
  inboundCapture:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs',
  responsesCodec:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_openai_codec.rs',
  continuationOwner:
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
  responseSse: 'src/server/handlers/handler-response-sse.ts',
  responsesSseBridge: 'src/modules/llmswitch/bridge/responses-sse-bridge.ts',
  responseBridge:
    'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
  conversationStore:
    'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
  functionMap: 'docs/architecture/function-map.yml',
  verificationMap: 'docs/architecture/verification-map.yml',
  mainlineMap: 'docs/architecture/mainline-call-map.yml',
  servertoolManifest:
    'docs/architecture/mainline-manifests/servertool.hook_skeleton.mainline.yml',
  continuationManifest:
    'docs/architecture/mainline-manifests/responses.continuation.mainline.yml',
  testDesign: 'docs/goals/servertool-hook-mount-boundary-test-design.md',
  packageJson: 'package.json',
};

function write(relativePath, content) {
  const absolutePath = path.join(tmpRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function seedPassingFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  write(
    paths.engine,
    'fn execute() { run_servertool_response_hooks(); }\n'
  );
  write(
    paths.requestOwner,
    'fn apply() { run_servertool_request_hooks(); }\n'
  );
  write(
    paths.hookRuntime,
    'use servertool_core::hook_skeleton_contract::plan_servertool_hook_schedule;\n' +
      'pub(crate) fn run_servertool_response_hooks() {}\n' +
      'pub(crate) fn run_servertool_request_hooks() {}\n'
  );
  write(
    paths.hookRegistry,
    'const ID: &str = "stop_message_auto";\n' +
      'const REQUIRED: ServertoolHookRequiredness = ServertoolHookRequiredness::Required;\n'
  );
  write(
    paths.stoplessHook,
    'fn run_stopless_response_hook() {}\nfn rewrite_stopless_request_after_restore() {}\n'
  );
  for (const key of [
    'standardizedRequest',
    'inboundNormalizer',
    'inboundCapture',
    'responsesCodec',
    'responseSse',
    'responsesSseBridge',
    'responseBridge',
    'conversationStore',
  ]) {
    write(paths[key], '// normalization or transport only\n');
  }
  write(paths.continuationOwner, 'fn restore() { normalize_responses_history_items(); }\n');
  write(
    paths.functionMap,
    [
      'owners:',
      '  - feature_id: hub.servertool_stopless_cli_continuation',
      '    required_gates:',
      '      - npm run verify:servertool-mount-boundary',
      '  - feature_id: hub.chat_process_responses_continuation',
      '    required_gates:',
      '      - npm run verify:servertool-mount-boundary',
      '',
    ].join('\n')
  );
  write(
    paths.verificationMap,
    [
      'verification:',
      '  - feature_id: hub.servertool_stopless_cli_continuation',
      '    smoke:',
      '      - npm run verify:servertool-mount-boundary',
      '',
    ].join('\n')
  );
  write(
    paths.mainlineMap,
    [
      'Stopless has no standalone lifecycle entrypoint.',
      'ServertoolReqHook',
      'ServertoolRespHook',
      'ChatProcRespContinuation07CanonicalSaved',
      'ChatProcReqContinuation03CanonicalRestored',
      '',
    ].join('\n')
  );
  write(paths.servertoolManifest, 'stopless_standalone_entrypoints: 0\n');
  write(paths.continuationManifest, 'servertool_semantic_nodes: 0\n');
  write(paths.testDesign, 'canonical continuation save and restore\n');
  write(
    paths.packageJson,
    JSON.stringify(
      {
        scripts: {
          'verify:servertool-mount-boundary':
            'node scripts/architecture/verify-servertool-mount-boundary.mjs',
          'test:servertool-mount-boundary-red-fixtures':
            'node scripts/tests/servertool-mount-boundary-red-fixtures.mjs',
          'verify:architecture-review-surface-light':
            'npm run verify:servertool-mount-boundary',
          'verify:architecture-ci-longtail':
            'npm run test:servertool-mount-boundary-red-fixtures',
        },
      },
      null,
      2
    )
  );
}

function expectFailure(name, mutate, expected) {
  seedPassingFixture();
  mutate();
  const failures = verifyServertoolMountBoundary(tmpRoot);
  if (failures.length === 0) {
    throw new Error(`${name}: expected gate failure`);
  }
  if (!failures.some((failure) => failure.includes(expected))) {
    throw new Error(
      `${name}: expected failure containing ${JSON.stringify(expected)}\n${failures.join('\n')}`
    );
  }
  return name;
}

const cases = [
  expectFailure(
    'stopless-direct-engine-bypass',
    () => {
      write(
        paths.engine,
        'fn execute() { run_servertool_response_hooks(); run_stopless_auto_handler_runtime_json(); }\n'
      );
    },
    'direct stopless response lifecycle bypasses'
  ),
  expectFailure(
    'stopless-semantic-in-responses-codec',
    () => {
      write(paths.responsesCodec, 'fn codec() { parse_stopless_cli_output(); }\n');
    },
    'servertool/stopless semantic token is forbidden'
  ),
  expectFailure(
    'stopless-semantics-inside-continuation-owner',
    () => {
      write(
        paths.continuationOwner,
        'fn restore() { collapse_auto_stop_hook_pairs_in_history(); build_stop_hook_guidance_text_from_output(); }\n'
      );
    },
    'servertool/stopless semantic token is forbidden'
  ),
  expectFailure(
    'missing-stopless-request-rewrite-handler',
    () => {
      write(paths.stoplessHook, 'fn run_stopless_response_hook() {}\n');
    },
    'missing registered stopless request rewrite handler'
  ),
  expectFailure(
    'missing-request-skeleton-entry',
    () => {
      write(paths.requestOwner, 'fn apply() {}\n');
    },
    'ReqChatProcess must enter the standard servertool request skeleton'
  ),
  expectFailure(
    'immutable-interval-manifest-unlocked',
    () => {
      write(paths.continuationManifest, 'servertool_semantic_nodes: 1\n');
    },
    'immutable interval must declare zero servertool semantic nodes'
  ),
];

console.log('[test:servertool-mount-boundary-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
