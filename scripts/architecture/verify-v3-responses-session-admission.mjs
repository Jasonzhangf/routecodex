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

function yamlListEntry(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const indent = marker.match(/^\s*/u)?.[0] ?? "";
  const end = source.indexOf(`\n${indent}- `, start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

const server = readRequired("v3/crates/routecodex-v3-server/src/lib.rs");
const serverFrameBuilders = readRequired(
  "v3/crates/routecodex-v3-server/src/frame_builders.rs",
);
const serverAll = server + "\n" + serverFrameBuilders;
const admission = readRequired(
  "v3/crates/routecodex-v3-server/src/session_admission.rs",
);
const config = readRequired("v3/crates/routecodex-v3-config/src/lib.rs");
const configTypes = readRequired("v3/crates/routecodex-v3-config/src/types.rs");
const configTests = readRequired(
  "v3/crates/routecodex-v3-config/tests/config_v3_contract.rs",
);
const tests = readRequired(
  "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
);
const functionMap = readRequired("docs/architecture/v3-function-map.yml");
const resourceMap = readRequired("docs/architecture/v3-resource-operation-map.yml");
const mainlineMap = readRequired("docs/architecture/v3-mainline-call-map.yml");
const verificationMap = readRequired("docs/architecture/v3-verification-map.yml");
const manifest = readRequired(
  "docs/architecture/manifests/v3.responses_session_admission.mainline.yml",
);
const wiki = readRequired(
  "docs/architecture/wiki/v3-responses-session-admission.md",
);
const admissionFunctionContract = yamlListEntry(
  functionMap,
  "- feature_id: v3.responses_session_inflight_admission",
);
const admissionResourceContract = yamlListEntry(
  resourceMap,
  "  - resource_id: v3.server.responses_session_admission",
);
const admissionMainlineContract = yamlListEntry(
  mainlineMap,
  "- chain_id: v3.responses_session_admission",
);
const admissionVerificationContract = yamlListEntry(
  verificationMap,
  "- feature_id: v3.responses_session_inflight_admission",
);
const keepaliveManifest = readRequired(
  "docs/architecture/manifests/v3.sse.http_keepalive.mainline.yml",
);
const keepaliveWiki = readRequired(
  "docs/architecture/wiki/v3-sse-http-keepalive.md",
);
const workflow = readRequired(".github/workflows/test.yml");
let packageJson = {};
try {
  packageJson = JSON.parse(readRequired("package.json"));
} catch (parseError) {
  failures.push(`package.json is not valid JSON: ${parseError.message}`);
}

requireMatch(
  server,
  /responses_session_admission:\s*Arc<V3ResponsesSessionAdmissionGate>/,
  "V3ListenerState must own one listener-local Responses session admission gate",
);
requireMatch(
  server,
  /read_json_payload\(request\)\.await[\s\S]*admit_v3_responses_session_after_json_parse\([\s\S]*\)\.await[\s\S]*pending_endpoint_after_responses_admission/,
  "Responses handler must await explicit-scope admission after the canonical JSON parser and before Runtime execution",
);
forbidMatch(
  server,
  /responses_session_admission_middleware|V3ResponsesAdmissionParsedPayload/,
  "Session admission must not create middleware JSON parsing or parsed-payload bypass owners",
);
requireMatch(
  `${server}\n${admission}`,
  /hold_response_body_admission_permit[\s\S]*body\.into_data_stream\(\)[\s\S]*Body::from_stream/,
  "Admission permit must be held by the HTTP response body lifetime",
);
requireMatch(
  admission,
  /pub\(crate\) async fn admit\([\s\S]*let notified = self\.notify\.notified\(\);[\s\S]*tokio::pin!\(notified\);[\s\S]*notified\.as_mut\(\)\.enable\(\);[\s\S]*self\.try_admit\(scope\.clone\(\)\)[\s\S]*notified\.await/,
  "The session admission gate must uniquely own an async predicate wait with lost-wakeup-safe notification ordering",
);
requireMatch(
  server,
  /\.responses_session_admission\s*\.admit\(V3ResponsesSessionAdmissionScope\s*\{[\s\S]*?\}\)\s*\.await/,
  "The V3 Server caller must await the gate owner instead of projecting overlap",
);
forbidMatch(
  server,
  /responses_session_admission\s*\.\s*try_admit|V3HttpBoundaryErrorKind::RequestInFlight/,
  "The V3 Server caller must not convert admission contention into request_in_flight",
);
forbidMatch(
  admission,
  /pub\(crate\)\s+fn\s+try_admit/,
  "Nonblocking admission must not be exported for server callers",
);
requireMatch(
  admission,
  /impl Drop for V3ResponsesSessionAdmissionPermit[\s\S]*\.active[\s\S]*\.remove\(&token\)[\s\S]*notify\.notify_waiters\(\)/,
  "Permit drop must remove only its exact token and wake every predicate waiter",
);
requireMatch(
  admission,
  /same_present_identity\(&active\.session_id,\s*&scope\.session_id\)[\s\S]*\|\|[\s\S]*same_present_identity\([\s\S]*active\.conversation_id/,
  "Waiting contention must match either the explicit session or explicit conversation",
);
requireMatch(
  serverAll,
  /build_v3_sse_transport_out_04_keepalive_comment\(" keepalive"\)[\s\S]*keepalive_interval[\s\S]*tokio::select!/,
  "Successful V3 Responses SSE must schedule transport-only keepalive comments",
);
forbidMatch(
  server,
  /ROUTECODEX_HTTP_SSE_KEEPALIVE_MS|RCC_HTTP_SSE_KEEPALIVE_MS/,
  "V3 Server must consume typed keepalive config instead of reading environment variables",
);
requireMatch(
  configTypes,
  /pub struct V3ServerManifest[\s\S]*pub http_sse_keepalive_ms:\s*u64/,
  "Config05 server manifest must publish the validated HTTP SSE keepalive interval",
);
requireMatch(
  config,
  /pub fn resolve_v3_http_sse_keepalive_ms[\s\S]*RCC_HTTP_SSE_KEEPALIVE_MS is not supported[\s\S]*ROUTECODEX_HTTP_SSE_KEEPALIVE_MS/,
  "Config owner must reject the retired legacy keepalive variable and compile only the canonical setting",
);
requireMatch(
  config,
  /http_sse_keepalive_environment_compiler_rejects_invalid_primary[\s\S]*http_sse_keepalive_environment_compiler_rejects_legacy_variable[\s\S]*http_sse_keepalive_environment_compiler_rejects_non_utf8_values/,
  "Real environment compiler must have invalid-primary, retired-legacy, and non-UTF8 negative tests",
);
requireMatch(
  configTests,
  /http_sse_keepalive_config_rejects_empty_malformed_zero_and_legacy_values/,
  "Config keepalive truth must have explicit negative tests",
);
requireMatch(
  serverAll,
  /v3_client_sse_body\(stream,\s*None\)/,
  "Error06/foundation SSE must bypass success keepalive injection",
);
forbidMatch(
  admission,
  /provider|virtual_router|continuation|codec|history|tool_call|fallback/i,
  "Session admission owner must not contain provider, routing, continuation, codec, history, tool, or fallback semantics",
);

for (const [source, pattern, label] of [
  [
    functionMap,
    /feature_id:\s*v3\.responses_session_inflight_admission\b/,
    "V3 function map must register the admission feature",
  ],
  [
    resourceMap,
    /resource_id:\s*v3\.server\.responses_session_admission\b/,
    "V3 resource map must register the listener-scoped gate",
  ],
  [
    mainlineMap,
    /chain_id:\s*v3\.responses_session_admission\b/,
    "V3 mainline map must bind the admission lifecycle",
  ],
  [
    verificationMap,
    /feature_id:\s*v3\.responses_session_inflight_admission\b/,
    "V3 verification map must bind required positive and negative gates",
  ],
  [
    manifest,
    /lifecycle_id:\s*v3\.responses_session_admission\.mainline\b/,
    "Admission lifecycle manifest must use the registered lifecycle id",
  ],
  [
    wiki,
    /V3Server03ResponsesSessionAdmissionBlock/,
    "Admission wiki must expose the review node",
  ],
  [
    mainlineMap,
    /chain_id:\s*v3\.sse\.http_keepalive_boundary[\s\S]*owner_feature_id:\s*v3\.sse_http_keepalive_boundary\b/,
    "V3 mainline map must bind the HTTP keepalive boundary to its server-owned feature",
  ],
  [
    keepaliveManifest,
    /lifecycle_id:\s*v3\.sse\.http_keepalive\.mainline[\s\S]*owner_feature_id:\s*v3\.sse_http_keepalive_boundary\b/,
    "HTTP keepalive lifecycle manifest must use the registered server-owned feature",
  ],
  [
    keepaliveWiki,
    /Error06 SSE starts with `event: error`/,
    "HTTP keepalive wiki must preserve Error06 first-frame polarity",
  ],
  [
    tests,
    /responses_same_listener_same_session_waits_for_release_then_returns_ok/,
    "Controlled provider overlap wait-then-200 blackbox must exist",
  ],
  [
    tests,
    /responses_same_listener_different_session_remains_concurrent/,
    "Controlled different-scope concurrency blackbox must exist",
  ],
  [
    tests,
    /responses_client_drop_releases_same_session_before_provider_eof/,
    "Controlled HTTP blackbox must prove client drop releases admission before provider EOF",
  ],
  [
    functionMap,
    /feature_id:\s*v3\.sse_http_keepalive_boundary[\s\S]*owner_crate:\s*routecodex-v3-server[\s\S]*entry_symbols:[\s\S]*v3_io_sse_body/,
    "Function map must register keepalive scheduling under the V3 Server owner",
  ],
  [
    resourceMap,
    /resource_id:\s*v3\.config\.http_sse_keepalive_interval\b/,
    "V3 resource map must register the typed keepalive config truth",
  ],
  [
    mainlineMap,
    /v3-sse-http-keepalive-01[\s\S]*side_channel_reads:\s*\[v3\.config\.http_sse_keepalive_interval\]/,
    "HTTP keepalive edge must truthfully read the typed Config05 interval",
  ],
]) {
  requireMatch(source, pattern, label);
}

const scripts = packageJson.scripts ?? {};
for (const scriptName of [
  "verify:v3-responses-session-admission",
  "test:v3-responses-session-admission-red-fixtures",
  "test:v3-responses-session-admission",
]) {
  if (typeof scripts[scriptName] !== "string") {
    failures.push(`package.json is missing ${scriptName}`);
  }
}
const admissionBehaviorGate = scripts["test:v3-responses-session-admission"];
for (const [testName, diagnostic] of [
  [
    "responses_same_listener_same_session_waits_for_release_then_returns_ok",
    "Admission behavior gate must execute the same-scope wait-then-200 blackbox",
  ],
  [
    "responses_same_listener_different_session_remains_concurrent",
    "Admission behavior gate must execute the different-scope concurrency blackbox",
  ],
  [
    "responses_client_drop_releases_same_session_before_provider_eof",
    "Admission behavior gate must execute the controlled client-drop HTTP blackbox",
  ],
]) {
  if (
    typeof admissionBehaviorGate !== "string" ||
    !admissionBehaviorGate.includes(testName)
  ) {
    failures.push(diagnostic);
  }
}
for (const scriptName of [
  "verify:v3-architecture-docs",
  "build:v3-cli",
  "test:v3-workspace",
]) {
  if (
    typeof scripts[scriptName] !== "string" ||
    !scripts[scriptName].includes("verify:v3-responses-session-admission")
  ) {
    failures.push(`${scriptName} must run verify:v3-responses-session-admission`);
  }
}
requireMatch(
  workflow,
  /npm run verify:v3-responses-session-admission/,
  "CI must run the admission verifier",
);
requireMatch(
  workflow,
  /npm run test:v3-responses-session-admission-red-fixtures/,
  "CI must run the admission red fixtures",
);
requireMatch(
  workflow,
  /^\s*run:\s*npm run test:v3-responses-session-admission\s*$/m,
  "CI must run the actual admission and keepalive behavior gate",
);
requireMatch(
  functionMap,
  /<V3ResponsesSessionAdmissionPermit as Drop>::drop/,
  "Function map must anchor the real Drop trait implementation symbol",
);
requireMatch(
  resourceMap,
  /<V3ResponsesSessionAdmissionPermit as Drop>::drop/,
  "Resource map must anchor the real Drop trait implementation symbol",
);
requireMatch(
  `${admissionFunctionContract}\n${admissionResourceContract}\n${admissionMainlineContract}\n${admissionVerificationContract}\n${manifest}\n${wiki}`,
  /V3ResponsesSessionAdmissionGate::admit/,
  "Canonical maps and lifecycle docs must bind the async admission owner",
);
forbidMatch(
  `${admissionMainlineContract}\n${admissionVerificationContract}\n${manifest}\n${wiki}`,
  /request_in_flight|HTTP 409|returns?\s+409|rejects?\s+(?:the\s+)?second request/i,
  "Canonical admission contracts must not retain the retired HTTP 409 overlap path",
);
forbidMatch(
  `${functionMap}\n${resourceMap}`,
  /V3ResponsesSessionAdmissionPermit::drop/,
  "Maps must not claim a nonexistent inherent permit drop symbol",
);

if (failures.length > 0) {
  console.error("[verify:v3-responses-session-admission] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-responses-session-admission] PASS");
