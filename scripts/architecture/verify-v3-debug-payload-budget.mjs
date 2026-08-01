#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];

function readRequired(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    failures.push(`missing required source: ${relative}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function requireMatch(source, pattern, label) {
  if (!pattern.test(source)) failures.push(label);
}

function forbidMatch(source, pattern, label) {
  if (pattern.test(source)) failures.push(label);
}

const debug = readRequired("v3/crates/routecodex-v3-debug/src/lib.rs");
const debugTests = readRequired(
  "v3/crates/routecodex-v3-debug/tests/debug_runtime_contract.rs",
);
const server = readRequired("v3/crates/routecodex-v3-server/src/lib.rs");
const v3FunctionMap = readRequired("docs/architecture/v3-function-map.yml");
const functionMap = readRequired("docs/architecture/function-map.yml");
const v3ResourceMap = readRequired(
  "docs/architecture/v3-resource-operation-map.yml",
);
const resourceMap = readRequired("docs/architecture/resource-operation-map.yml");
const v3VerificationMap = readRequired(
  "docs/architecture/v3-verification-map.yml",
);
const verificationMap = readRequired("docs/architecture/verification-map.yml");
const workflow = readRequired(".github/workflows/test.yml");
let packageJson = {};
try {
  packageJson = JSON.parse(readRequired("package.json"));
} catch (error) {
  failures.push(`package.json is not valid JSON: ${error.message}`);
}

requireMatch(
  debug,
  /const V3_DEBUG_MAX_PAYLOAD_BYTES:\s*usize\s*=\s*64\s*\*\s*1024;/,
  "Debug must own the 64 KiB whole-artifact byte limit",
);
requireMatch(
  debug,
  /pub fn redact_debug_value[\s\S]*serde_json::to_vec\(&redacted\)[\s\S]*serialized_bytes\.len\(\)\s*<=\s*V3_DEBUG_MAX_PAYLOAD_BYTES[\s\S]*serialized_payload_budget_exceeded_placeholder/,
  "Debug must enforce the byte limit against the final serialized artifact",
);
requireMatch(
  debug,
  /pub struct V3DebugBoundedTextCapture[\s\S]*V3_DEBUG_MAX_STREAM_CAPTURE_BYTES[\s\S]*ROUTECODEX_DEBUG_STREAM_TRUNCATED/,
  "Debug must own bounded SSE text capture with an explicit truncation marker",
);
requireMatch(
  server,
  /raw_sse:\s*Arc<Mutex<V3DebugBoundedTextCapture>>/,
  "Server SSE recorders must use Debug-owned bounded capture",
);
requireMatch(
  server,
  /struct V3LiveSnapRelayRecordedStream[\s\S]*Poll::Ready\(None\)[\s\S]*persist_current\(None\)/,
  "Relay sample persistence must finalize once at stream EOF",
);
requireMatch(
  server,
  /struct V3LiveSnapDirectRecordedStream[\s\S]*Poll::Ready\(None\)[\s\S]*persist_current\(None\)/,
  "Direct sample persistence must finalize once at stream EOF",
);
for (const recorder of [
  "V3LiveSnapClientResponseSseRecorder",
  "V3LiveSnapDirectClientResponseSseRecorder",
]) {
  const start = server.indexOf(`impl ${recorder}`);
  const append = server.indexOf("fn append_chunk", start);
  const persist = server.indexOf("fn persist_current", append);
  if (start < 0 || append < 0 || persist < 0) {
    failures.push(`${recorder} append/finalize methods must exist`);
    continue;
  }
  forbidMatch(
    server.slice(append, persist),
    /persist_(?:current|v3_codex_sample_payload)/,
    `${recorder} must not rewrite the artifact for every stream chunk`,
  );
}
const directProjectionStart = server.indexOf(
  "fn responses_direct_output_response_with_console(",
);
const directProjectionEnd = server.indexOf(
  "\nfn wrap_v3_direct_sse_console_stream(",
  directProjectionStart,
);
const directProjection =
  directProjectionStart >= 0 && directProjectionEnd > directProjectionStart
    ? server.slice(directProjectionStart, directProjectionEnd)
    : "";
requireMatch(
  directProjection,
  /V3Server16Body::Sse\(stream\)[\s\S]*v3_client_sse_body\(stream,\s*None\)/,
  "Direct SSE projection must preserve provider bytes without keepalive injection",
);
forbidMatch(
  directProjection,
  /v3_client_sse_body\(stream,\s*Some\(|successful_sse/,
  "Direct SSE projection must not derive or enable transport keepalive",
);
requireMatch(
  server,
  /fn resolve_v3_codex_samples_root\(\)\s*->\s*Result<PathBuf,\s*String>[\s\S]*requires HOME[\s\S]*requires non-empty HOME/,
  "Codex-sample filesystem root resolution must reject missing or blank HOME",
);
requireMatch(
  server,
  /fn persist_v3_codex_sample_payload[\s\S]{0,900}resolve_v3_codex_samples_root\(\)\?/,
  "Authorized persistence must use the explicit Codex-sample root resolver",
);
requireMatch(
  server,
  /fn enforce_v3_codex_sample_listener_retention[\s\S]{0,300}resolve_v3_codex_samples_root\(\)\?/,
  "Startup retention must use the explicit Codex-sample root resolver",
);
for (const testName of [
  "debug_side_channel_caps_final_serialized_artifact_with_sensitive_wide_objects",
  "debug_stream_capture_retains_a_bounded_prefix_and_explicit_truncation_truth",
]) {
  requireMatch(debugTests, new RegExp(`fn ${testName}\\b`), `${testName} must exist`);
}
for (const [source, label] of [
  [v3FunctionMap, "V3 function map"],
  [functionMap, "global function map"],
  [v3VerificationMap, "V3 verification map"],
  [verificationMap, "global verification map"],
]) {
  requireMatch(
    source,
    /feature_id:\s*v3\.codex_sample_retention_snap_scope\b/,
    `${label} must register v3.codex_sample_retention_snap_scope`,
  );
  requireMatch(
    source,
    /verify:v3-debug-payload-budget/,
    `${label} must bind the V3 debug payload budget gate`,
  );
}
for (const [source, label] of [
  [v3ResourceMap, "V3 resource map"],
  [resourceMap, "global resource map"],
]) {
  requireMatch(
    source,
    /resource_id:\s*v3\.debug\.payload_budget\b/,
    `${label} must register v3.debug.payload_budget`,
  );
}

const scripts = packageJson.scripts ?? {};
for (const scriptName of [
  "verify:v3-debug-payload-budget",
  "test:v3-debug-payload-budget-red-fixtures",
]) {
  if (typeof scripts[scriptName] !== "string") {
    failures.push(`package.json is missing ${scriptName}`);
  }
}
if (
  typeof scripts["build:v3-cli"] !== "string" ||
  !scripts["build:v3-cli"].includes("verify:v3-debug-payload-budget")
) {
  failures.push("build:v3-cli must run verify:v3-debug-payload-budget");
}
requireMatch(
  workflow,
  /npm run verify:v3-debug-payload-budget/,
  "CI must run the V3 debug payload budget verifier",
);
requireMatch(
  workflow,
  /npm run test:v3-debug-payload-budget-red-fixtures/,
  "CI must run the V3 debug payload budget red fixtures",
);

if (failures.length > 0) {
  console.error("[verify:v3-debug-payload-budget] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-debug-payload-budget] PASS");
