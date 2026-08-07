#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.V3_PROVIDER_SESSION_COOLDOWN_ROOT
  ? path.resolve(process.env.V3_PROVIDER_SESSION_COOLDOWN_ROOT)
  : process.cwd();
const failures = [];

function readRequired(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    failures.push(`missing required source: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function requireMatch(source, pattern, label) {
  if (!pattern.test(source)) failures.push(label);
}

function forbidMatch(source, pattern, label) {
  if (pattern.test(source)) failures.push(label);
}

function extractBracedBlock(source, marker, label) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    failures.push(`missing ${label}`);
    return "";
  }
  const blockStart = source.indexOf("{", markerIndex + marker.length);
  if (blockStart < 0) {
    failures.push(`missing ${label} body`);
    return "";
  }
  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(blockStart, index + 1);
    }
  }
  failures.push(`unterminated ${label} body`);
  return "";
}

function extractYamlItem(source, key, value, label) {
  const marker = `  - ${key}: ${value}`;
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trimEnd() === marker.trimEnd());
  if (start < 0) {
    failures.push(`missing ${label}`);
    return "";
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  - \S/u.test(lines[index]) || /^- chain_id:/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function requireBlockLine(block, pattern, label) {
  requireMatch(block, pattern, label);
}

function forbidBlockLine(block, pattern, label) {
  forbidMatch(block, pattern, label);
}


const files = {
  error: "v3/crates/routecodex-v3-error/src/lib.rs",
  health: "v3/crates/routecodex-v3-provider-responses/src/health.rs",
  actionGate: "v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs",
  policy: "v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs",
  nodes: "v3/crates/routecodex-v3-runtime/src/nodes.rs",
  kernel: "v3/crates/routecodex-v3-runtime/src/kernel.rs",
  directRuntimeHelpers:
    "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs",
  directSse:
    "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
  responses:
    "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
  openaiChat:
    "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs",
  anthropic:
    "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs",
  gemini:
    "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs",
  server: "v3/crates/routecodex-v3-server/src/lib.rs",
  serverTests: "v3/crates/routecodex-v3-server/src/tests/mod.rs",
  serverBlackbox: "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
  packageJson: "package.json",
  resourceMap: "docs/architecture/v3-resource-operation-map.yml",
  functionMap: "docs/architecture/v3-function-map.yml",
  mainlineMap: "docs/architecture/v3-mainline-call-map.yml",
  verificationMap: "docs/architecture/v3-verification-map.yml",
};
const source = Object.fromEntries(
  Object.entries(files).map(([key, relativePath]) => [key, readRequired(relativePath)]),
);

requireMatch(
  source.error,
  /pub struct V3ProviderFailureSessionScope\s*\{[\s\S]*server_id:\s*String,[\s\S]*routing_group:\s*String,[\s\S]*session_id:\s*String,/u,
  "Error owner must define the typed server+routing_group+session_id failure scope",
);
const error05RecoveryWitnessStruct = extractBracedBlock(
  source.error,
  "pub struct V3Error05RecoveryAdmissionWitness",
  "V3Error05RecoveryAdmissionWitness",
);
requireMatch(
  error05RecoveryWitnessStruct,
  /failure_session_scope:\s*V3ProviderFailureSessionScope/u,
  "Error05 recovery witness must carry the typed failure session scope",
);
requireMatch(
  source.error,
  /impl V3Error05RecoveryAdmissionWitness\s*\{[\s\S]*pub fn new\(\s*failure_session_scope:\s*V3ProviderFailureSessionScope,/u,
  "Error05 witness constructor must require an already validated typed session scope",
);
const healthSessionKeyStruct = extractBracedBlock(
  source.health,
  "struct V3ProviderFailureSessionKey",
  "V3ProviderFailureSessionKey",
);
requireMatch(
  healthSessionKeyStruct,
  /server_id:\s*String,[\s\S]*routing_group:\s*String,[\s\S]*session_id:\s*String,[\s\S]*provider_runtime_identity:\s*String,/u,
  "Provider Health must key failure-derived state by server, group, session, and runtime identity",
);
requireMatch(
  source.health,
  /pub struct V3ProviderSessionAvailabilityReader/u,
  "Provider Health must expose a session-bound read-only availability reader",
);
requireMatch(
  source.health,
  /try_acquire_cross_session_revive/u,
  "Provider Health must own atomic cross-session revive admission",
);
requireMatch(
  source.health,
  /original_cooldown_until_ms/u,
  "Revive state must retain the original cooldown deadline",
);
requireMatch(
  source.health,
  /retain\(|remove_expired_session_state/u,
  "Provider Health must deterministically clean bounded session state",
);
requireMatch(
  source.resourceMap,
  /resource_id:\s*v3\.provider\.health_state[\s\S]*identity:\s*\[serverId,\s*routingGroup,\s*sessionId,\s*providerRuntimeIdentity\]/u,
  "Resource map must bind provider health state identity to server+routing_group+session+runtime identity",
);
requireMatch(
  source.resourceMap,
  /resource_id:\s*v3\.provider\.health_state[\s\S]*allowed_writers:\s*\[[^\]]*V3ProviderHealthStore::record_provider_failure_in_session[^\]]*V3ProviderHealthStore::record_provider_success_in_session[^\]]*V3ProviderHealthStore::try_acquire_cross_session_revive[^\]]*\]/u,
  "Resource map provider health writers must name only session-scoped health mutation owners",
);
requireMatch(
  source.resourceMap,
  /resource_id:\s*v3\.provider\.health_state[\s\S]*allowed_readers:\s*\[[^\]]*V3ProviderHealthStore::availability_for_session[^\]]*V3ProviderSessionAvailabilityReader::availability[^\]]*V3ProviderHealthStore::try_acquire_cross_session_revive[^\]]*\]/u,
  "Resource map provider health readers must name the session-bound availability projection owner",
);
forbidMatch(
  source.resourceMap,
  /allowed_writers:\s*\[[^\]]*V3ProviderFailureRuntimeHealth::record_provider_failure_record[^\]]*\]/u,
  "Resource map must not register Runtime wrappers as provider health state writers",
);
forbidMatch(
  source.resourceMap,
  /resource_id:\s*v3\.provider\.health_state[\s\S]*\bV3ProviderHealthStore::record_provider_failure\b|resource_id:\s*v3\.provider\.health_state[\s\S]*\bV3ProviderHealthStore::record_provider_success\b/u,
  "Resource map must not retain legacy provider-global health mutation owners",
);
requireMatch(
  source.resourceMap,
  /resource_id:\s*v3\.provider\.availability_projection[\s\S]*identity:\s*\[providerId,\s*authAlias,\s*modelId,\s*available,\s*blockedScopes\]/u,
  "Resource map availability projection must expose blocked session scopes rather than pretending provider-global truth",
);
const validatedHttpInputResource = extractYamlItem(
  source.resourceMap,
  "resource_id",
  "v3.server.validated_http_input",
  "v3.server.validated_http_input resource",
);
requireBlockLine(
  validatedHttpInputResource,
  /identity:\s*\[[^\]]*requestSessionIdHeader[^\]]*\]/u,
  "Validated HTTP input must declare the existing request session ID header",
);
requireBlockLine(
  validatedHttpInputResource,
  /allowed_readers:\s*\[[^\]]*build_v3_provider_failure_session_scope_for_request[^\]]*\]/u,
  "Validated HTTP input must allow only the Server scope builder to consume the session control header",
);
requireBlockLine(
  validatedHttpInputResource,
  /may_enter_provider_body:\s*false[\s\S]*may_enter_client_body:\s*false/u,
  "Validated HTTP input control header must not enter provider or client bodies",
);
const failureSessionScopeResource = extractYamlItem(
  source.resourceMap,
  "resource_id",
  "v3.provider.failure_session_scope",
  "v3.provider.failure_session_scope resource",
);
requireBlockLine(
  failureSessionScopeResource,
  /resource_kind:\s*side_channel/u,
  "Resource map failure session scope must be a side-channel control resource",
);
requireBlockLine(
  failureSessionScopeResource,
  /owner_crate:\s*routecodex-v3-error/u,
  "Resource map failure session scope must be owned by Error, not Server or Provider Health",
);
requireBlockLine(
  failureSessionScopeResource,
  /owner_node:\s*V3ProviderFailureSessionScope/u,
  "Resource map failure session scope must bind to the typed scope node",
);
requireBlockLine(
  failureSessionScopeResource,
  /identity:\s*\[serverId,\s*routingGroup,\s*sessionId\]/u,
  "Resource map failure session scope identity must be server+routing_group+session only",
);
requireBlockLine(
  failureSessionScopeResource,
  /allowed_writers:\s*\[V3ProviderFailureSessionScope::new\]/u,
  "Resource map failure session scope writer must be only the typed scope constructor",
);
requireBlockLine(
  failureSessionScopeResource,
  /allowed_readers:\s*\[[^\]]*V3Error05RecoveryAdmissionWitness::new[^\]]*V3ProviderFailureRuntimeHealth::record_provider_failure_record[^\]]*V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope[^\]]*V3ProviderFailureRuntimeHealth::session_bound_availability[^\]]*V3ProviderActionProviderScope::new[^\]]*V3ProviderSessionAvailabilityReader::availability[^\]]*\]/u,
  "Resource map failure session scope readers must be the typed runtime/error/action/availability consumers",
);
forbidBlockLine(
  failureSessionScopeResource,
  /allowed_writers:\s*\[[^\]]*(routecodex-v3-server|V3ProviderHealthStore::record_provider_failure_in_session|V3ProviderHealthStore::record_provider_success_in_session|V3ProviderHealthStore::try_acquire_cross_session_revive)[^\]]*\]/u,
  "Resource map failure session scope must not be written by Server or Provider Health",
);
requireBlockLine(
  failureSessionScopeResource,
  /may_enter_provider_body:\s*false[\s\S]*may_enter_client_body:\s*false/u,
  "Resource map failure session scope must not enter provider or client bodies",
);
const debugErrorFunction = extractYamlItem(
  source.functionMap,
  "feature_id",
  "v3.debug_error_foundation",
  "v3.debug_error_foundation function map feature",
);
requireBlockLine(
  debugErrorFunction,
  /- v3\.provider\.failure_session_scope/u,
  "Function map must bind the provider failure session scope resource",
);
requireMatch(
  source.functionMap,
  /feature_id:\s*v3\.debug_error_foundation[\s\S]*V3ProviderFailureRuntimeHealth::record_provider_failure_record[\s\S]*V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope[\s\S]*V3ProviderFailureRuntimeHealth::session_bound_availability[\s\S]*V3ProviderSessionAvailabilityReader::availability[\s\S]*V3ProviderHealthStore::record_provider_failure_in_session[\s\S]*V3ProviderHealthStore::record_provider_success_in_session[\s\S]*V3ProviderHealthStore::availability_for_session[\s\S]*V3ProviderHealthStore::try_acquire_cross_session_revive[\s\S]*build_v3_provider_failure_session_scope_for_request/u,
  "Function map must bind the session health owner, scoped availability, revive admission, and request scope builder",
);
forbidMatch(
  source.functionMap,
  /feature_id:\s*v3\.debug_error_foundation[\s\S]*V3ProviderHealthStore::record_provider_failure\n|feature_id:\s*v3\.debug_error_foundation[\s\S]*V3ProviderHealthStore::record_provider_success\n/u,
  "Function map must not retain removed provider-global health entry symbols",
);
requireMatch(
  source.mainlineMap,
  /step_id:\s*v3-de-13[\s\S]*caller_symbol:\s*V3ProviderSessionAvailabilityReader::availability[\s\S]*callee_symbol:\s*V3ProviderHealthStore::availability_for_session/u,
  "Mainline map v3-de-13 must bind session-bound availability to availability_for_session",
);
requireMatch(
  source.mainlineMap,
  /step_id:\s*v3-de-14[\s\S]*caller_symbol:\s*V3ProviderFailureRuntimeHealth::record_provider_failure_record[\s\S]*callee_symbol:\s*V3ProviderHealthStore::record_provider_failure_in_session/u,
  "Mainline map v3-de-14 must bind typed failure recording to the session-scoped health store",
);
requireMatch(
  source.mainlineMap,
  /step_id:\s*v3-de-15[\s\S]*caller_symbol:\s*V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope[\s\S]*callee_symbol:\s*V3ProviderHealthStore::record_provider_success_in_session/u,
  "Mainline map v3-de-15 must bind typed success recording to the session-scoped health store",
);
forbidMatch(
  source.mainlineMap,
  /step_id:\s*v3-de-1[45][\s\S]*callee_symbol:\s*V3ProviderHealthStore::record_provider_(failure|success)\b/u,
  "Mainline map must not point direct health edges at removed provider-global APIs",
);
const de18Edge = extractYamlItem(
  source.mainlineMap,
  "step_id",
  "v3-de-18",
  "v3-de-18 failure session scope edge",
);
requireBlockLine(
  de18Edge,
  /from_node:\s*V3Server03HttpRequestRaw/u,
  "Mainline map v3-de-18 must start from the server request data-plane node",
);
requireBlockLine(
  de18Edge,
  /to_node:\s*V3ProviderFailureSessionScope/u,
  "Mainline map v3-de-18 must produce the typed provider failure session scope node",
);
requireBlockLine(
  de18Edge,
  /caller_symbol:\s*build_v3_provider_failure_session_scope_for_request[\s\S]*caller_file:\s*v3\/crates\/routecodex-v3-server\/src\/lib\.rs/u,
  "Mainline map v3-de-18 caller must be the Server request-plane scope builder",
);
requireBlockLine(
  de18Edge,
  /callee_symbol:\s*V3ProviderFailureSessionScope::new[\s\S]*callee_file:\s*v3\/crates\/routecodex-v3-error\/src\/lib\.rs/u,
  "Mainline map v3-de-18 callee must be the Error-owned typed scope constructor",
);
requireBlockLine(
  de18Edge,
  /owner_feature_id:\s*v3\.debug_error_foundation/u,
  "Mainline map v3-de-18 must remain owned by v3.debug_error_foundation",
);
requireBlockLine(
  de18Edge,
  /consumes:[\s\S]*- v3\.server\.validated_http_input[\s\S]*- v3\.request\.protocol_context/u,
  "Mainline map v3-de-18 must consume only validated HTTP-boundary input and protocol context",
);
requireBlockLine(
  de18Edge,
  /produces:[\s\S]*- v3\.provider\.failure_session_scope/u,
  "Mainline map v3-de-18 must produce provider failure session scope, not provider health",
);
requireBlockLine(
  de18Edge,
  /side_channel_writes:[\s\S]*- v3\.provider\.failure_session_scope/u,
  "Mainline map v3-de-18 must write the failure session scope side-channel resource",
);
forbidBlockLine(
  de18Edge,
  /to_node:\s*V3ProviderHealthStateMutated|v3\.provider\.health_state/u,
  "Mainline map v3-de-18 must not claim Provider Health mutation or health_state production",
);
requireMatch(
  source.verificationMap,
  /verify:v3-provider-session-cooldown/u,
  "Verification map must require the provider session cooldown architecture gate",
);

const actionGateKeyStruct = extractBracedBlock(
  source.actionGate,
  "pub struct V3ProviderActionGateKey",
  "V3ProviderActionGateKey",
);
requireMatch(
  actionGateKeyStruct,
  /session_id:\s*String,/u,
  "Provider ActionGate key must include session_id",
);
const actionProviderScopeImpl = extractBracedBlock(
  source.actionGate,
  "impl V3ProviderActionProviderScope",
  "V3ProviderActionProviderScope impl",
);
requireMatch(
  actionProviderScopeImpl,
  /pub fn new\(\s*failure_session_scope:\s*&V3ProviderFailureSessionScope,/u,
  "Provider ActionGate provider scope constructor must require typed session scope",
);
const actionProviderScopeStruct = extractBracedBlock(
  source.actionGate,
  "pub struct V3ProviderActionProviderScope",
  "V3ProviderActionProviderScope",
);
requireMatch(
  actionProviderScopeStruct,
  /session_id:\s*String,/u,
  "Provider ActionGate success/recovery scope must include session_id",
);

for (const [label, runtimeSource, marker] of [
  ["Direct raw request", source.nodes, "pub struct V3Server03HttpRequestRaw"],
  ["Responses Relay", source.responses, "pub struct V3ResponsesRelayRuntimeInput"],
  ["OpenAI Chat Relay", source.openaiChat, "pub struct V3OpenAiChatRelayRuntimeInput"],
  ["Anthropic Relay", source.anthropic, "pub struct V3AnthropicRelayRuntimeInput"],
  ["Gemini Relay", source.gemini, "pub struct V3GeminiRelayRuntimeInput"],
]) {
  const runtimeInputStruct = extractBracedBlock(runtimeSource, marker, `${label} runtime input`);
  requireMatch(
    runtimeInputStruct,
    /failure_session_scope:\s*V3ProviderFailureSessionScope/u,
    `${label} must carry the typed failure session scope`,
  );
}

requireMatch(
  source.server,
  /V3ProviderFailureSessionScope::new\(/u,
  "Server/ReqInbound must construct the validated typed failure session scope",
);
requireMatch(
  source.serverTests,
  /fn provider_failure_scope_uses_existing_session_header\(\)/u,
  "Server must lock the existing request session header as provider failure scope",
);
requireMatch(
  source.serverTests,
  /fn provider_failure_scope_uses_internal_request_id_without_client_session_header\(\)/u,
  "Server must isolate headerless requests with their existing internal request id",
);
requireMatch(
  source.serverBlackbox,
  /async fn responses_direct_without_failure_session_header_reaches_provider\(\)/u,
  "Server blackbox must prove a missing client session header does not block provider send",
);
requireMatch(
  source.packageJson,
  /"test:v3-provider-session-cooldown":[^\n]*-p routecodex-v3-provider-responses --lib health::tests[^\n]*responses_direct_without_failure_session_header_reaches_provider/u,
  "Provider session cooldown gate must avoid unrelated integration binaries and run the headerless-request blackbox",
);
const serverFailureSessionScopeResolver = extractBracedBlock(
  source.server,
  "fn get_failure_session_scope",
  "Server provider failure session scope resolver",
);
const serverFailureSessionScopeBuilder = extractBracedBlock(
  source.server,
  "fn build_v3_provider_failure_session_scope_for_request",
  "Server provider failure session scope builder",
);
const serverFailureSessionHeaderReader = extractBracedBlock(
  source.server,
  "fn provider_failure_session_id_from_request_headers",
  "Server provider failure session header reader",
);
requireMatch(
  serverFailureSessionHeaderReader,
  /first_header_text[\s\S]*"session-id"[\s\S]*"session_id"[\s\S]*"x-session-id"[\s\S]*"x-rcc-session-id"/u,
  "Server failure scope builder must consume the existing request session header",
);
requireMatch(
  serverFailureSessionScopeBuilder,
  /V3ProviderFailureSessionScope::new\(&server\.id,\s*&server\.routing_group,\s*&session_id\)/u,
  "Server failure scope builder must construct the typed scope from the validated session control header",
);
forbidMatch(
  serverFailureSessionScopeBuilder,
  /request_id|parse_codex_turn_metadata|TURN_METADATA_SESSION_PATHS|BODY_SESSION_PATHS|client_metadata|metadata|conversation_id|unwrap_or/u,
  "Server failure scope builder must not derive control identity from request identity or payload metadata",
);
requireMatch(
  serverFailureSessionScopeResolver,
  /V3ProviderFailureSessionScope::new\([\s\S]*&server\.id,[\s\S]*&server\.routing_group,[\s\S]*format!\("request-local-\{request_id\}"\)/u,
  "Server must build a headerless request-local control scope without changing client headers or payload",
);
forbidMatch(
  serverFailureSessionScopeResolver,
  /headers\.insert|payload|client_metadata|metadata/u,
  "Headerless failure-scope isolation must not synthesize headers or rebuild control from payload",
);
requireMatch(
  `${source.kernel}\n${source.directSse}\n${source.responses}\n${source.openaiChat}\n${source.anthropic}\n${source.gemini}`,
  /record_post_commit_provider_stream_failure\([\s\S]*failure_session_scope/u,
  "post-commit failure handling must receive the same typed session scope",
);
requireMatch(
  source.policy,
  /session_bound_availability|availability_for_session/u,
  "Runtime policy must construct session-bound availability",
);
requireMatch(
  source.policy,
  /reselect_from_captured_target_plan[\s\S]*selected\.route/u,
  "Runtime recovery must re-expand and reselect only from selected.route's captured Target07 plan",
);
requireMatch(
  source.policy,
  /try_acquire_cross_session_revive/u,
  "Runtime policy must consume Health-owned atomic revive admission",
);
const directFailurePolicyBody = extractBracedBlock(
  source.directRuntimeHelpers,
  "async fn run_v3_direct_provider_failure_policy",
  "Direct provider failure policy",
);
requireMatch(
  directFailurePolicyBody,
  /try_acquire_cross_session_revive/u,
  "Direct provider failure policy must consume Health-owned atomic revive admission",
);
const directSseOutcomeStruct = extractBracedBlock(
  source.directSse,
  "pub(super) struct V3DirectSseProviderOutcome",
  "Direct SSE provider outcome",
);
requireMatch(
  directSseOutcomeStruct,
  /failure_session_scope:\s*V3ProviderFailureSessionScope/u,
  "Direct SSE post-commit outcome must retain the original typed failure session scope",
);
const kernelProductionSource = source.kernel.split("#[cfg(test)]", 1)[0];
forbidMatch(
  kernelProductionSource,
  /direct_failure_session_id|continuation_scope[\s\S]{0,240}failure_session_scope/u,
  "Direct runtime must not derive provider failure scope from continuation state",
);

forbidMatch(
  `${source.policy}\n${source.kernel}\n${source.responses}\n${source.openaiChat}\n${source.anthropic}\n${source.gemini}`,
  /session_id\s*=\s*(request_id|conversation_id)|unwrap_or\([^\n]*(request_id|conversation_id)/u,
  "Runtime must not derive failure session identity from request_id or conversation_id",
);
forbidMatch(
  `${source.error}\n${source.actionGate}`,
  /session_id:\s*routing_group|V3ProviderFailureSessionScope::new\([^\n]*server_id[^\n]*routing_group\.clone\(\)[^\n]*routing_group/u,
  "routing_group must never substitute for the real session_id",
);
forbidMatch(
  source.health,
  /record_(provider_failure|provider_success)\(\s*&self,\s*provider_id:/u,
  "legacy provider-global failure/success mutation API must be physically removed",
);
const failurePolicyBody = source.policy.slice(
  source.policy.indexOf("pub(crate) async fn run_v3_relay_provider_failure_policy("),
  source.policy.indexOf("\nfn build_v3_relay_provider_error_05_decision(", source.policy.indexOf("pub(crate) async fn run_v3_relay_provider_failure_policy(")),
);
forbidMatch(
  failurePolicyBody,
  /resolve_v3_relay_target(?:_outcome)?\(/u,
  "recovery must not perform a second Virtual Router/Target plan build",
);
forbidMatch(
  `${source.kernel}\n${source.responses}\n${source.openaiChat}\n${source.anthropic}\n${source.gemini}`,
  /cooldown_until_ms\s*=\s*[^;]*(now|now_ms)[^;]*cooldown_ms/u,
  "failed revive must not replace the original cooldown deadline",
);

if (failures.length > 0) {
  console.error("V3 provider session cooldown verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("V3 provider session cooldown verification passed.");
