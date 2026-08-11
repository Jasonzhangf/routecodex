#!/usr/bin/env node

// V3 debug/sample fidelity verifier: debug payloads and codex samples must be
// preserved verbatim. All truncation and placeholder machinery is forbidden:
// payload budgets, omitted-item placeholders, oversized-string truncation,
// key truncation, stream-capture truncation, and media placeholders.

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

// 占位符与截断机制必须物理不存在。
const placeholderPattern =
  /ROUTECODEX_DEBUG_|__routecodex_debug_|V3_DEBUG_MAX_|V3DebugPayloadBudget|payload_budget_exhausted_placeholder|serialized_payload_budget_exceeded_placeholder|object_items_omitted_placeholder|array_items_omitted_placeholder|normalize_debug_object_key|should_omit_debug_media_string/;
forbidMatch(
  debug,
  placeholderPattern,
  "Debug crate must not contain any truncation or placeholder machinery",
);
forbidMatch(
  server,
  /ROUTECODEX_DEBUG_|__routecodex_debug_/,
  "Server must not contain debug truncation or placeholder markers",
);
forbidMatch(
  debugTests,
  /assert!\([^!\n]*\.contains\("ROUTECODEX_DEBUG_|assert!\([^!\n]*contains\("ROUTECODEX_DEBUG_/,
  "Debug contract tests must not assert placeholder presence",
);

// 样本落盘唯一化：server 禁止保留任何零散持久化实现，只能调 debug crate 的
// V3CodexSampleStore；截断/占位对采样无意义，样本必须保真。
const sampleStore = readRequired(
  "v3/crates/routecodex-v3-debug/src/sample_store.rs",
);
requireMatch(
  sampleStore,
  /pub struct V3CodexSampleStore/,
  "Codex-sample persistence must be owned by a single V3CodexSampleStore",
);
requireMatch(
  sampleStore,
  /pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 200;/,
  "Codex-sample retention must default to 200 requests",
);
requireMatch(
  sampleStore,
  /pub fn persist\([\s\S]*force: bool[\s\S]*if !self\.enabled && !force \{\s*return Ok\(\(\)\);\s*\}/,
  "V3CodexSampleStore.persist must force-write error evidence even when disabled",
);
requireMatch(
  sampleStore,
  /pub fn enforce_listener_retention\(&self, port: u16\)/,
  "V3CodexSampleStore must own startup listener retention",
);
requireMatch(
  sampleStore,
  /fn resolve_v3_codex_samples_root\(\)\s*->\s*Result<PathBuf,\s*String>[\s\S]*requires HOME[\s\S]*requires non-empty HOME/,
  "Codex-sample filesystem root resolution must reject missing or blank HOME",
);
for (const leaked of [
  /fn resolve_v3_codex_samples_root/,
  /fn format_v3_codex_sample_endpoint_dir/,
  /fn encode_v3_codex_sample_path_segment/,
  /fn persist_v3_codex_sample_payload_unchecked/,
  /fn enforce_v3_codex_sample_request_retention/,
  /fn enforce_v3_codex_sample_listener_retention/,
  /codex_sample_persistence: Arc<Mutex/,
  /V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 100/,
]) {
  forbidMatch(
    server,
    leaked,
    "Server must not reimplement codex-sample persistence (unique owner is V3CodexSampleStore)",
  );
}
requireMatch(
  server,
  /codex_sample_store: Arc<routecodex_v3_debug::V3CodexSampleStore>/,
  "Server listener state must hold the single V3CodexSampleStore",
);
requireMatch(
  server,
  /fn persist_v3_error_evidence_payload[\s\S]{0,600}payload,\s*\n\s*true,\s*\n\s*\)/,
  "Error evidence must force-write samples even when sampling is disabled",
);
requireMatch(
  server,
  /fn v3_codex_sample_scope_allows[\s\S]*state\.codex_sample_store\.is_enabled\(\)/,
  "Direct-sample scope gate must consult the store enablement flag",
);
requireMatch(
  server,
  /fn build_v3_debug_runtime_from_manifest[\s\S]*unwrap_or\(200\) as usize[\s\S]*unwrap_or\(200\) as usize/,
  "In-memory raw request/response retention must default to 200",
);
const configTypes = readRequired("v3/crates/routecodex-v3-config/src/types.rs");
const configValidate = readRequired(
  "v3/crates/routecodex-v3-config/src/validate.rs",
);
requireMatch(
  configTypes,
  /pub codex_samples: Option<bool>/,
  "Authoring config must allow explicit codex_samples override",
);
requireMatch(
  configValidate,
  /codex_samples: authoring\s*\n?\s*\.codex_samples\s*\n?\s*\.unwrap_or\(cfg!\(debug_assertions\)\)/,
  "Dev builds must enable codex samples by default; release builds must require explicit opt-in",
);

// 保真语义必须存在：全量捕获 + 纯 redaction。
requireMatch(
  debug,
  /pub fn redact_debug_value[\s\S]*redact_debug_value_at_key\(policy,\s*None,\s*value\)/,
  "redact_debug_value must delegate to pure redaction without a budget",
);
requireMatch(
  debug,
  /pub struct V3DebugBoundedTextCapture[\s\S]*pub fn append[\s\S]*self\.bytes\.extend_from_slice\(bytes\)/,
  "BoundedTextCapture must append full stream text without truncation",
);
requireMatch(
  debug,
  /fn redact_debug_value_at_key[\s\S]*Value::String\(text\)\s+if\s+looks_like_secret_literal\(&text\)/,
  "Redaction must keep secret-literal redaction",
);

// 安全 redaction 标记必须保留（sensitive key / secret literal）。
requireMatch(
  debug,
  /Value::String\("\[REDACTED\]"\.to_string\(\)\)/,
  "Debug must keep [REDACTED] security redaction",
);

requireMatch(
  server,
  /raw_sse:\s*Arc<Mutex<V3DebugBoundedTextCapture>>/,
  "Server SSE recorders must use Debug-owned capture",
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
  /V3Server16Body::Sse\(stream\)[\s\S]*v3_client_sse_body\(stream,\s*keepalive\)/,
  "Direct SSE projection must inject server keepalive (client/provider decoupled)",
);
forbidMatch(
  directProjection,
  /v3_client_sse_body\(stream,\s*None\)/,
  "Direct SSE projection must not pass keepalive=None for success streams",
);
for (const testName of [
  "debug_side_channel_preserves_large_history_arrays_verbatim",
  "debug_stream_capture_preserves_full_text_verbatim",
  "debug_side_channel_preserves_media_and_oversized_strings_and_redacts_secrets",
]) {
  requireMatch(debugTests, new RegExp(`fn ${testName}\\b`), `${testName} must exist`);
}
requireMatch(
  sampleStore,
  /persist_writes_verbatim_sample_when_enabled/,
  "Sample store must have a verbatim persistence test",
);
requireMatch(
  sampleStore,
  /persist_forces_error_evidence_when_disabled/,
  "Sample store must have a forced error-evidence test",
);
requireMatch(
  sampleStore,
  /retention_caps_samples_at_configured_limit[\s\S]*200/,
  "Sample store must have a retention-cap test at 200",
);
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
    `${label} must bind the V3 debug sample-fidelity gate`,
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
  "CI must run the V3 debug sample-fidelity verifier",
);
requireMatch(
  workflow,
  /npm run test:v3-debug-payload-budget-red-fixtures/,
  "CI must run the V3 debug sample-fidelity red fixtures",
);

if (failures.length > 0) {
  console.error("[verify:v3-debug-payload-budget] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-debug-payload-budget] PASS");
