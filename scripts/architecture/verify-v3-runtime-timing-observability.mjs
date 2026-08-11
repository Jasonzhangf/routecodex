#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

const root = process.cwd();
const runtimeTimingPath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/runtime_timing.rs",
);
const runtimeLibPath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/lib.rs",
);
const relayRuntimePath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
);
const kernelPath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/kernel.rs",
);
const directStatePath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs",
);
const directSseOutcomePath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
);
const directRuntimeHelpersPath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs",
);
const kernelTestsPath = path.join(
  root,
  "v3/crates/routecodex-v3-runtime/src/kernel/tests.rs",
);
const serverPath = path.join(
  root,
  "v3/crates/routecodex-v3-server/src/lib.rs",
);
const directServerOutcomePath = path.join(
  root,
  "v3/crates/routecodex-v3-server/src/responses_direct_server_outcome.rs",
);
const serverTestsPath = path.join(
  root,
  "v3/crates/routecodex-v3-server/src/tests/mod.rs",
);
const v3FunctionMapPath = path.join(root, "docs/architecture/v3-function-map.yml");
const functionMapPath = path.join(root, "docs/architecture/function-map.yml");
const v3ResourceMapPath = path.join(
  root,
  "docs/architecture/v3-resource-operation-map.yml",
);
const resourceMapPath = path.join(
  root,
  "docs/architecture/resource-operation-map.yml",
);
const v3MainlineMapPath = path.join(
  root,
  "docs/architecture/v3-mainline-call-map.yml",
);
const mainlineMapPath = path.join(
  root,
  "docs/architecture/mainline-call-map.yml",
);
const v3VerificationMapPath = path.join(
  root,
  "docs/architecture/v3-verification-map.yml",
);
const verificationMapPath = path.join(
  root,
  "docs/architecture/verification-map.yml",
);
const manifestPath = path.join(
  root,
  "docs/architecture/manifests/v3.runtime_timing_observability.mainline.yml",
);
const packagePath = path.join(root, "package.json");
const workflowPath = path.join(root, ".github/workflows/test.yml");

const failures = [];

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing required source: ${path.relative(root, filePath)}`);
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function requireMatch(source, pattern, label) {
  if (!pattern.test(source)) {
    failures.push(label);
  }
}

function forbidMatch(source, pattern, label) {
  if (pattern.test(source)) {
    failures.push(label);
  }
}

function parseYaml(source, label) {
  try {
    return YAML.parse(source) ?? {};
  } catch (error) {
    failures.push(`${label} is not valid YAML: ${error.message}`);
    return {};
  }
}

const runtimeTiming = readRequired(runtimeTimingPath);
const runtimeLib = readRequired(runtimeLibPath);
const relayRuntime = readRequired(relayRuntimePath);
const runtimeObservability = relayRuntime.slice(
  relayRuntime.indexOf("pub struct V3RuntimeObservability"),
  relayRuntime.indexOf(
    "\n}\n\n#[derive(Debug, Clone, Default)]",
    relayRuntime.indexOf("pub struct V3RuntimeObservability"),
  ) + 2,
);
const kernel = readRequired(kernelPath);
const directState = readRequired(directStatePath);
const directSseOutcome = readRequired(directSseOutcomePath);
const directRuntimeHelpers = readRequired(directRuntimeHelpersPath);
const kernelTests = readRequired(kernelTestsPath);
const directSseOutcomeWrapper = directSseOutcome.slice(
  directSseOutcome.indexOf("pub(super) fn wrap_direct_sse_provider_outcome_stream("),
);
const server = readRequired(serverPath);
const consoleImpl = readRequired(
  path.join(
    root,
    "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
  ),
);
const directServerOutcome = readRequired(directServerOutcomePath);
const serverTests = readRequired(serverTestsPath);
const serverAndTests = `${server}
${serverTests}`;
const serverProduction =
  server.split("#[cfg(test)]")[0] +
  "\n" +
  consoleImpl.split("#[cfg(test)]")[0];
const responseProjection = serverProduction.slice(
  serverProduction.indexOf("fn emit_v3_request_complete_console_line("),
  serverProduction.indexOf(
    "\nfn format_v3_console_runtime_timing(",
    serverProduction.indexOf("fn emit_v3_request_complete_console_line("),
  ),
);
function sliceRustFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) {
    return "";
  }
  const next = source.indexOf("\n    fn ", start + signature.length);
  const nextPub = source.indexOf("\n    pub(crate) fn ", start + signature.length);
  const nextPubFn = source.indexOf("\n    pub fn ", start + signature.length);
  const candidates = [next, nextPub, nextPubFn].filter((candidate) => candidate !== -1);
  const boundary = candidates.length === 0 ? -1 : Math.min(...candidates);
  return source.slice(start, boundary === -1 ? source.length : boundary);
}

function sliceTokioTest(source, testName) {
  const signature = `async fn ${testName}(`;
  const start = source.indexOf(signature);
  if (start === -1) {
    return "";
  }
  const nextCandidates = [
    source.indexOf("\n#[tokio::test]", start + signature.length),
    source.indexOf("\n    #[tokio::test]", start + signature.length),
  ].filter((candidate) => candidate !== -1);
  if (nextCandidates.length === 0) {
    return "";
  }
  return source.slice(start, Math.min(...nextCandidates));
}

const directFinalizer = serverProduction.slice(
  serverProduction.indexOf("impl V3DirectSseConsoleFinalizer {"),
  serverProduction.indexOf(
    "\nfn read_v3_environment_context_cwd_from_text(",
    serverProduction.indexOf("impl V3DirectSseConsoleFinalizer {"),
  ),
);
const directCompleteProjection = sliceRustFunction(
  directFinalizer,
  "fn emit_direct_sse_complete_console_lines(self)",
);
const directClientDisconnected = sliceRustFunction(
  directFinalizer,
  "fn client_disconnected(mut self)",
);
const directPreEofCloseoutTest = sliceTokioTest(
  serverAndTests,
  "direct_sse_console_closeout_does_not_fabricate_success_or_error_before_runtime_eof",
);
const directCleanEofMissingTimingTest = sliceTokioTest(
  serverAndTests,
  "direct_sse_console_clean_eof_exposes_missing_runtime_timing_contract",
);
const v3FunctionMap = readRequired(v3FunctionMapPath);
const functionMap = readRequired(functionMapPath);
const v3ResourceMap = readRequired(v3ResourceMapPath);
const resourceMap = readRequired(resourceMapPath);
const v3MainlineMap = readRequired(v3MainlineMapPath);
const mainlineMap = readRequired(mainlineMapPath);
const v3VerificationMap = readRequired(v3VerificationMapPath);
const verificationMap = readRequired(verificationMapPath);
const manifest = readRequired(manifestPath);
const workflow = readRequired(workflowPath);
let packageJson = {};
try {
  packageJson = JSON.parse(readRequired(packagePath));
} catch (error) {
  failures.push(`package.json is not valid JSON: ${error.message}`);
}

requireMatch(
  runtimeTiming,
  /pub struct V3RuntimeTimingSummary\s*\{[\s\S]*pub runtime_total:\s*Duration,[\s\S]*pub external:\s*Duration,[\s\S]*pub internal:\s*Duration,/,
  "Runtime timing summary must expose typed runtime_total/external/internal durations",
);
requireMatch(
  runtimeLib,
  /mod runtime_timing;/,
  "Runtime must own the timing module",
);
requireMatch(
  runtimeLib,
  /pub use runtime_timing::\{V3RuntimeObservabilityAccumulator, V3RuntimeTimingSummary\};/,
  "Runtime must expose the typed timing summary and opaque handoff accumulator",
);
requireMatch(
  runtimeTiming,
  /pub struct V3RuntimeObservabilityAccumulator\s*\{[\s\S]*timing:\s*V3RuntimeTimingState,[\s\S]*attempts:\s*usize,/,
  "Runtime must own one typed timing and attempt accumulator across protocol handoffs",
);
requireMatch(
  `${directState}\n${relayRuntime}`,
  /V3ResponsesProtocolRelayHandoff[\s\S]*observability_accumulator:\s*V3RuntimeObservabilityAccumulator[\s\S]*V3ResponsesProtocolDirectHandoff[\s\S]*observability_accumulator:\s*V3RuntimeObservabilityAccumulator|V3ResponsesProtocolDirectHandoff[\s\S]*observability_accumulator:\s*V3RuntimeObservabilityAccumulator[\s\S]*V3ResponsesProtocolRelayHandoff[\s\S]*observability_accumulator:\s*V3RuntimeObservabilityAccumulator/,
  "Both typed protocol handoff directions must carry the Runtime observability accumulator",
);
requireMatch(
  directServerOutcome,
  /Some\(handoff\.observability_accumulator\)[\s\S]*Some\(next_handoff\.observability_accumulator\)/,
  "Server must move the opaque accumulator through Direct-to-Relay and nested Relay-to-Direct handoffs",
);
requireMatch(
  runtimeObservability,
  /pub timing:\s*Option<V3RuntimeTimingSummary>,/,
  "V3RuntimeObservability must carry the Runtime-owned timing summary",
);
requireMatch(
  relayRuntime,
  /pub struct V3RuntimeStreamObservationSnapshot\s*\{[\s\S]*pub timing:\s*Option<V3RuntimeTimingSummary>,/,
  "Direct SSE stream observation must carry terminal Runtime timing",
);
requireMatch(
  relayRuntime,
  /transport\.send\(transport_request\)/,
  "Relay timing must remain adjacent to the provider transport attempt",
);
requireMatch(
  kernel,
  /wrap_direct_sse_provider_event_json_observation_stream\([\s\S]*runtime_timing/,
  "Direct SSE provider decoder must receive the Runtime timing state",
);
requireMatch(
  directRuntimeHelpers,
  /decoder[\s\S]*\.finish\(\)[\s\S]*finish_external\(\)/,
  "Direct SSE external timing must close only after decoder clean EOF",
);
requireMatch(
  kernel,
  /wrap_direct_sse_provider_outcome_stream\([\s\S]*runtime_timing/,
  "Direct SSE outer Runtime closeout must receive the Runtime timing state",
);
const directSseFinishRuntimeCalls =
  directSseOutcomeWrapper.match(/\.finish_runtime\(\)/g) ?? [];
if (directSseFinishRuntimeCalls.length !== 1) {
  failures.push(
    "Direct SSE terminal timing owner must call finish_runtime exactly once",
  );
}
const directSseDecoderFinish = directSseOutcomeWrapper.indexOf("decoder.finish()");
const directSseTerminalGuard = directSseOutcomeWrapper.indexOf(
  "if !state.provider_outcome.terminal",
);
const directSseSuccessRecord = directSseOutcomeWrapper.indexOf(
  "state.provider_outcome.record_success()",
);
const directSseRuntimeFinish = directSseOutcomeWrapper.indexOf(
  "state.runtime_timing.finish_runtime()",
);
const directSseTimingPublish = directSseOutcomeWrapper.indexOf(
  "state.stream_observation.record_timing(timing)",
);
if (
  !(
    directSseDecoderFinish >= 0 &&
    directSseDecoderFinish < directSseTerminalGuard &&
    directSseTerminalGuard < directSseSuccessRecord &&
    directSseSuccessRecord < directSseRuntimeFinish &&
    directSseRuntimeFinish < directSseTimingPublish
  )
) {
  failures.push(
    "Direct SSE finish_runtime must follow decoder clean EOF, terminal validation, and provider success before timing publication",
  );
}
forbidMatch(
  directSseOutcome,
  /\.unwrap_or\("provider_response_failed"\)|\.unwrap_or\("provider response stream reported failure"\)/,
  "Direct SSE provider failure events must not invent missing error code or message",
);
forbidMatch(
  directSseOutcome,
  /event\.get\("response"\)\.unwrap_or\(&event\)/,
  "Direct SSE provider failure events must require the canonical response object",
);
requireMatch(
  directSseOutcome,
  /event\s*\.get\("response"\)\s*\.and_then\(Value::as_object\)[\s\S]*requires a response object[\s\S]*provider_response_sse_event_invalid/,
  "Direct SSE provider failure events must reject a missing response object as provider_response_sse_event_invalid",
);
requireMatch(
  directSseOutcome,
  /response\.error\.code[\s\S]*provider_response_sse_event_invalid[\s\S]*response\.error\.message/,
  "Direct SSE provider failure events must reject missing error fields as provider_response_sse_event_invalid",
);
requireMatch(
  directSseOutcome,
  /if sse_event_type != json_event_type[\s\S]*provider Responses SSE event name[\s\S]*does not match JSON type[\s\S]*provider_response_sse_event_invalid/,
  "Direct SSE provider outcome must reject mismatched SSE event and JSON types",
);
requireMatch(
  kernelTests,
  /async fn direct_sse_event_name_json_type_mismatch_is_protocol_invalid\(\)[\s\S]*provider_response_sse_event_invalid[\s\S]*does not match JSON type[\s\S]*timing\.is_none\(\)/,
  "Direct SSE mismatch regression must prove explicit failure without successful timing",
);
forbidMatch(
  serverProduction,
  /time_[ie]=unreported/,
  "Server production projection must not emit unreported Runtime timing",
);
forbidMatch(
  serverProduction,
  /internal_(?:ms|timing)\s*[:=]\s*(?:elapsed|0)|external_(?:ms|timing)\s*[:=]\s*(?:elapsed|0)/,
  "Server must not synthesize Runtime internal/external timing",
);
forbidMatch(
  serverProduction,
  /V3RuntimeTimingSummary\s*\{/,
  "Server production must not construct Runtime timing summaries",
);
requireMatch(
  serverProduction,
  /observability\.timing/,
  "Server must project timing from V3RuntimeObservability",
);
requireMatch(
  directClientDisconnected,
  /is_v3_sse_terminal_success_status\(&status\)[\s\S]*if self\.observability\.timing\.is_none\(\)\s*\{\s*return;[\s\S]*emit_direct_sse_complete_console_lines/,
  "Direct SSE pre-EOF drop must suppress terminal projection until Runtime timing exists",
);
forbidMatch(
  directCompleteProjection,
  /observability\.timing\.is_none\(\)[\s\S]*return;/,
  "Direct SSE clean-EOF completion must not suppress a missing Runtime timing contract failure",
);
requireMatch(
  directPreEofCloseoutTest,
  /assert!\(!log\.contains\("event=completed"\)/,
  "Direct SSE pre-EOF terminal-drop test must reject fabricated completion",
);
requireMatch(
  directPreEofCloseoutTest,
  /assert!\(!log\.contains\("event=failed"\)/,
  "Direct SSE pre-EOF terminal-drop test must reject fabricated failure",
);
requireMatch(
  directPreEofCloseoutTest,
  /assert!\(!log\.contains\("status=500"\)/,
  "Direct SSE pre-EOF terminal-drop test must reject fabricated HTTP 500 projection",
);
requireMatch(
  directPreEofCloseoutTest,
  /assert!\(!log\.contains\("runtime_observability_contract"\)/,
  "Direct SSE pre-EOF terminal-drop test must reject fabricated observability contract errors",
);
requireMatch(
  directPreEofCloseoutTest,
  /assert!\(!log\.contains\("client_disconnect"\)/,
  "Direct SSE pre-EOF terminal-drop test must reject a false client disconnect",
);
requireMatch(
  directCleanEofMissingTimingTest,
  /assert!\(log\.contains\("event=failed"\)/,
  "Direct SSE clean-EOF missing-timing test must require an explicit failure",
);
requireMatch(
  directCleanEofMissingTimingTest,
  /assert!\(log\.contains\("status=500"\)/,
  "Direct SSE clean-EOF missing-timing test must require status 500",
);
requireMatch(
  directCleanEofMissingTimingTest,
  /assert!\([\s\S]*log\.contains\("subcode=runtime_observability_contract"\)/,
  "Direct SSE clean-EOF missing-timing test must require the Runtime observability contract code",
);
requireMatch(
  directCleanEofMissingTimingTest,
  /successful V3 Runtime observability is missing timing/,
  "Direct SSE clean-EOF missing-timing test must require the missing timing diagnostic",
);
requireMatch(
  directCleanEofMissingTimingTest,
  /assert!\(!log\.contains\("event=completed"\)/,
  "Direct SSE clean-EOF missing-timing test must reject fabricated completion",
);
requireMatch(
  responseProjection,
  /response_status[\s\S]*ok_or_else[\s\S]*missing response_status/,
  "Successful human response projection must reject missing response_status",
);
requireMatch(
  responseProjection,
  /finish_reason[\s\S]*ok_or_else[\s\S]*missing finish_reason/,
  "Successful human response projection must reject missing finish_reason",
);
requireMatch(
  responseProjection,
  /format_v3_console_human_usage_summary/,
  "Human response projection must omit unavailable usage instead of showing unreported",
);
forbidMatch(
  responseProjection,
  /unreported/,
  "Successful human response projection must not contain unreported placeholders",
);

for (const [source, label] of [
  [v3FunctionMap, "V3 function map"],
  [functionMap, "global function map"],
  [v3VerificationMap, "V3 verification map"],
  [verificationMap, "global verification map"],
]) {
  requireMatch(
    source,
    /feature_id:\s*v3\.runtime_timing_observability\b/,
    `${label} must register v3.runtime_timing_observability`,
  );
}

const timingStepIds = Array.from(
  { length: 14 },
  (_, index) => `v3-runtime-timing-${String(index + 1).padStart(2, "0")}`,
);
for (const [source, label] of [
  [v3MainlineMap, "V3 mainline map"],
  [mainlineMap, "global mainline map"],
]) {
  const parsed = parseYaml(source, label);
  const chain = (parsed.chains ?? []).find(
    (candidate) =>
      candidate?.chain_id === "v3.runtime_timing_observability.mainline",
  );
  const edges = chain?.edges ?? [];
  if (
    JSON.stringify(edges.map((edge) => edge?.step_id)) !==
    JSON.stringify(timingStepIds)
  ) {
    failures.push(`${label} must bind all Runtime timing edges 01 through 14`);
  }
  const streamMerge = edges.find(
    (edge) => edge?.step_id === "v3-runtime-timing-06",
  );
  if (
    streamMerge?.caller_symbol !== "complete_relay_sse" ||
    streamMerge?.callee_symbol !== "merge_v3_runtime_stream_observation"
  ) {
    failures.push(
      `${label} timing edge 06 must bind the real finalizer-to-stream-observation merge call`,
    );
  }
  const completionHandoff = edges.find(
    (edge) => edge?.step_id === "v3-runtime-timing-08",
  );
  if (
    completionHandoff?.caller_symbol !== "emit_relay_sse_complete_console_lines" ||
    completionHandoff?.callee_symbol !== "emit_v3_request_complete_console_line"
  ) {
    failures.push(
      `${label} timing edge 08 must bind the real finalizer completion handoff`,
    );
  }
  const directTimingPublication = edges.find(
    (edge) => edge?.step_id === "v3-runtime-timing-12",
  );
  if (
    directTimingPublication?.caller_symbol !==
      "wrap_direct_sse_provider_outcome_stream" ||
    directTimingPublication?.callee_symbol !== "record_timing" ||
    directTimingPublication?.callee_file !==
      "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs"
  ) {
    failures.push(
      `${label} timing edge 12 must bind Direct SSE timing publication to record_timing`,
    );
  }
  for (const edge of [
    edges.find((candidate) => candidate?.step_id === "v3-runtime-timing-05"),
    directTimingPublication,
  ]) {
    if (
      JSON.stringify(edge?.resource_flow ?? {}) !==
      JSON.stringify({
        consumes: ["v3.runtime.responses_timing_observability"],
        produces: ["v3.runtime.responses_observability"],
        side_channel_reads: ["v3.runtime.responses_timing_observability"],
        side_channel_writes: ["v3.runtime.responses_observability"],
      })
    ) {
      failures.push(
        `${label} record_timing edges must consume Runtime timing and write Runtime stream observability`,
      );
    }
  }
  for (const edge of [streamMerge, completionHandoff]) {
    if (
      !Array.isArray(edge?.resource_flow?.produces) ||
      edge.resource_flow.produces.length !== 0 ||
      !Array.isArray(edge?.resource_flow?.side_channel_writes) ||
      edge.resource_flow.side_channel_writes.length !== 0
    ) {
      failures.push(
        `${label} timing Server projection edges must not claim console terminal output writes`,
      );
    }
  }
}

const manifestParsed = parseYaml(manifest, "Runtime timing lifecycle manifest");
if (
  JSON.stringify((manifestParsed.edges ?? []).map((edge) => edge?.step_id)) !==
  JSON.stringify(timingStepIds)
) {
  failures.push(
    "Runtime timing lifecycle manifest must bind all Runtime timing edges 01 through 14",
  );
}
for (const stepId of ["v3-runtime-timing-05", "v3-runtime-timing-12"]) {
  const edge = (manifestParsed.edges ?? []).find(
    (candidate) => candidate?.step_id === stepId,
  );
  if (
    JSON.stringify(edge?.resource_flow ?? {}) !==
    JSON.stringify({
      consumes: ["v3.runtime.responses_timing_observability"],
      produces: ["v3.runtime.responses_observability"],
      side_channel_reads: ["v3.runtime.responses_timing_observability"],
      side_channel_writes: ["v3.runtime.responses_observability"],
    })
  ) {
    failures.push(
      `Runtime timing lifecycle manifest ${stepId} must lock record_timing resource flow`,
    );
  }
}
for (const [source, collection, label] of [
  [v3FunctionMap, "features", "V3 function map"],
  [functionMap, "owners", "global function map"],
  [v3VerificationMap, "features", "V3 verification map"],
]) {
  const parsed = parseYaml(source, label);
  const feature = (parsed[collection] ?? []).find(
    (candidate) => candidate?.feature_id === "v3.runtime_timing_observability",
  );
  if (
    JSON.stringify(feature?.mainline_bindings ?? []) !==
    JSON.stringify(timingStepIds)
  ) {
    failures.push(`${label} must bind all Runtime timing edges 01 through 14`);
  }
}
const globalVerification = parseYaml(
  verificationMap,
  "global verification map",
);
const globalVerificationFeature = (globalVerification.verification ?? []).find(
  (candidate) => candidate?.feature_id === "v3.runtime_timing_observability",
);
if (
  JSON.stringify(globalVerificationFeature?.mainline_bindings ?? []) !==
  JSON.stringify(timingStepIds)
) {
  failures.push(
    "global verification map must bind all Runtime timing edges 01 through 14",
  );
}
const directSseOutcomeOwnerPath =
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs";
for (const [source, collection, label, pathsKey] of [
  [functionMap, "owners", "global function map", "allowed_paths"],
  [v3FunctionMap, "features", "V3 function map", "owner_files"],
]) {
  const parsed = parseYaml(source, label);
  const feature = (parsed[collection] ?? []).find(
    (candidate) => candidate?.feature_id === "v3.runtime_timing_observability",
  );
  if (!Array.isArray(feature?.[pathsKey]) || !feature[pathsKey].includes(directSseOutcomeOwnerPath)) {
    failures.push(`${label} must register the Direct SSE outcome owner path`);
  }
}
for (const [source, label] of [
  [v3ResourceMap, "V3 resource map"],
  [resourceMap, "global resource map"],
]) {
  requireMatch(
    source,
    /resource_id:\s*v3\.runtime\.responses_timing_observability\b/,
    `${label} must register the Runtime timing resource`,
  );
}
for (const [source, label] of [
  [v3MainlineMap, "V3 mainline map"],
  [mainlineMap, "global mainline map"],
  [manifest, "Runtime timing lifecycle manifest"],
]) {
  requireMatch(
    source,
    /v3\.runtime_timing_observability\.mainline/,
    `${label} must register the Runtime timing lifecycle`,
  );
}
for (const source of [v3VerificationMap, verificationMap]) {
  forbidMatch(
    source,
    /Missing Runtime-owned internal\/external timing is explicitly projected as time_i=unreported/,
    "Verification maps must not require unreported timing on terminal success",
  );
}

const scripts = packageJson.scripts ?? {};
for (const scriptName of [
  "verify:v3-runtime-timing-observability",
  "test:v3-runtime-timing-observability-red-fixtures",
]) {
  if (typeof scripts[scriptName] !== "string") {
    failures.push(`package.json is missing ${scriptName}`);
  }
}
for (const scriptName of [
  "verify:v3-architecture-docs",
  "build:v3-cli",
  "test:v3-workspace",
]) {
  if (
    typeof scripts[scriptName] !== "string" ||
    !scripts[scriptName].includes("verify:v3-runtime-timing-observability")
  ) {
    failures.push(`${scriptName} must run verify:v3-runtime-timing-observability`);
  }
}
requireMatch(
  workflow,
  /npm run verify:v3-runtime-timing-observability/,
  "CI must run the Runtime timing verifier",
);
requireMatch(
  workflow,
  /npm run test:v3-runtime-timing-observability-red-fixtures/,
  "CI must run the Runtime timing red fixtures",
);

if (failures.length > 0) {
  console.error("[verify:v3-runtime-timing-observability] FAIL");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[verify:v3-runtime-timing-observability] PASS");
