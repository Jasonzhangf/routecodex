import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// feature_id: hub.servertool_hook_skeleton

const files = {
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

const forbiddenSemanticTokens = [
  'reasoningStop',
  'reasoning_stop',
  'stop_message_auto',
  'stop_message_flow',
  'stopless',
  'STOP_HOOK_COMMAND_MARKERS',
  'build_stop_hook_guidance',
  'parse_stopless',
  'collapse_auto_stop_hook',
];

function readRequired(root, relativePath, failures) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: required file is missing`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function readOptional(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) return '';
  return fs.readFileSync(absolutePath, 'utf8');
}

function productionRust(source) {
  const marker = source.indexOf('\n#[cfg(test)]');
  return marker === -1 ? source : source.slice(0, marker);
}

function featureSection(source, featureId) {
  const marker = `- feature_id: ${featureId}`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const next = source.indexOf('\n  - feature_id:', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function requireText(source, expected, message, failures) {
  if (!source.includes(expected)) failures.push(message);
}

function forbidText(source, forbidden, message, failures) {
  if (source.includes(forbidden)) failures.push(message);
}

function forbidSemanticTokens(relativePath, source, failures) {
  for (const token of forbiddenSemanticTokens) {
    forbidText(
      source,
      token,
      `${relativePath}: servertool/stopless semantic token is forbidden outside the standard hook skeleton: ${token}`,
      failures
    );
  }
}

export function verifyServertoolMountBoundary(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(files).map(([key, relativePath]) => {
      const optional = key === 'responsesSseBridge';
      return [
        key,
        optional ? readOptional(root, relativePath) : readRequired(root, relativePath, failures),
      ];
    })
  );

  requireText(
    sources.hookRuntime,
    'pub(crate) fn run_servertool_response_hooks',
    `${files.hookRuntime}: missing standard response hook skeleton entrypoint`,
    failures
  );
  requireText(
    sources.hookRuntime,
    'pub(crate) fn run_servertool_request_hooks',
    `${files.hookRuntime}: missing standard request hook skeleton entrypoint`,
    failures
  );
  requireText(
    sources.hookRuntime,
    'plan_servertool_hook_schedule',
    `${files.hookRuntime}: runtime skeleton must execute the servertool-core scheduler`,
    failures
  );
  requireText(
    sources.hookRegistry,
    'stop_message_auto',
    `${files.hookRegistry}: stopless must be registered as a servertool hook`,
    failures
  );
  requireText(
    sources.hookRegistry,
    'ServertoolHookRequiredness::Required',
    `${files.hookRegistry}: stopless hook requiredness must be explicit`,
    failures
  );
  requireText(
    sources.stoplessHook,
    'run_stopless_response_hook',
    `${files.stoplessHook}: missing registered stopless response hook handler`,
    failures
  );
  requireText(
    sources.stoplessHook,
    'rewrite_stopless_request_after_restore',
    `${files.stoplessHook}: missing registered stopless request rewrite handler`,
    failures
  );

  requireText(
    sources.engine,
    'run_servertool_response_hooks(',
    `${files.engine}: Hub response Chat Process must enter the standard servertool response skeleton`,
    failures
  );
  for (const token of [
    'run_servertool_resp_stopless_hook_skeleton',
    'run_stopless_auto_handler_runtime_json(',
    'build_stopless_auto_cli_projection_from_engine_json(',
  ]) {
    forbidText(
      productionRust(sources.engine),
      token,
      `${files.engine}: direct stopless response lifecycle bypasses the standard hook skeleton: ${token}`,
      failures
    );
  }

  requireText(
    sources.requestOwner,
    'run_servertool_request_hooks(',
    `${files.requestOwner}: ReqChatProcess must enter the standard servertool request skeleton`,
    failures
  );
  for (const [key, relativePath] of [
    ['standardizedRequest', files.standardizedRequest],
    ['inboundNormalizer', files.inboundNormalizer],
    ['inboundCapture', files.inboundCapture],
    ['responsesCodec', files.responsesCodec],
    ['continuationOwner', files.continuationOwner],
  ]) {
    forbidSemanticTokens(relativePath, productionRust(sources[key]), failures);
  }
  for (const [key, relativePath] of [
    ['responseSse', files.responseSse],
    ['responsesSseBridge', files.responsesSseBridge],
    ['responseBridge', files.responseBridge],
    ['conversationStore', files.conversationStore],
  ]) {
    forbidSemanticTokens(relativePath, sources[key], failures);
  }

  const servertoolFeature = featureSection(
    sources.functionMap,
    'hub.servertool_stopless_cli_continuation'
  );
  const continuationFeature = featureSection(
    sources.functionMap,
    'hub.chat_process_responses_continuation'
  );
  for (const section of [servertoolFeature, continuationFeature]) {
    requireText(
      section,
      'npm run verify:servertool-mount-boundary',
      `${files.functionMap}: affected feature must require the servertool mount boundary gate`,
      failures
    );
  }
  const verification = featureSection(
    sources.verificationMap,
    'hub.servertool_stopless_cli_continuation'
  );
  requireText(
    verification,
    'npm run verify:servertool-mount-boundary',
    `${files.verificationMap}: stopless verification must require the mount boundary gate`,
    failures
  );

  for (const required of [
    'Stopless has no standalone lifecycle entrypoint',
    'ServertoolReqHook',
    'ServertoolRespHook',
    'ChatProcRespContinuation07CanonicalSaved',
    'ChatProcReqContinuation03CanonicalRestored',
  ]) {
    requireText(
      sources.mainlineMap,
      required,
      `${files.mainlineMap}: missing servertool/continuation mount contract ${required}`,
      failures
    );
  }
  requireText(
    sources.servertoolManifest,
    'stopless_standalone_entrypoints: 0',
    `${files.servertoolManifest}: manifest must declare zero standalone stopless entrypoints`,
    failures
  );
  requireText(
    sources.continuationManifest,
    'servertool_semantic_nodes: 0',
    `${files.continuationManifest}: immutable interval must declare zero servertool semantic nodes`,
    failures
  );

  requireText(
    sources.testDesign,
    'canonical continuation save',
    `${files.testDesign}: missing save/restore boundary test design`,
    failures
  );

  let packageJson = {};
  try {
    packageJson = JSON.parse(sources.packageJson);
  } catch (error) {
    failures.push(`${files.packageJson}: invalid JSON: ${error.message}`);
  }
  const scripts = packageJson.scripts ?? {};
  for (const scriptName of [
    'verify:servertool-mount-boundary',
    'test:servertool-mount-boundary-red-fixtures',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`${files.packageJson}: missing script ${scriptName}`);
    }
  }
  for (const [parent, child] of [
    ['verify:architecture-review-surface-light', 'verify:servertool-mount-boundary'],
    ['verify:architecture-ci-longtail', 'test:servertool-mount-boundary-red-fixtures'],
  ]) {
    if (!(scripts[parent] ?? '').includes(child)) {
      failures.push(`${files.packageJson}: ${parent} must include ${child}`);
    }
  }

  return failures;
}

function runCli() {
  const root = process.env.ROUTECODEX_VERIFY_ROOT || process.cwd();
  const failures = verifyServertoolMountBoundary(root);
  if (failures.length > 0) {
    console.error('[verify:servertool-mount-boundary] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify:servertool-mount-boundary] ok');
  console.log('- all servertool semantics enter the standard Rust hook skeleton');
  console.log('- stopless is a registered hook with no standalone lifecycle entrypoint');
  console.log('- continuation save/restore immutable interval contains no servertool semantics');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli();
}
