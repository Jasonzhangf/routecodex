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

const server = readRequired("v3/crates/routecodex-v3-server/src/lib.rs");
const admission = readRequired(
  "v3/crates/routecodex-v3-server/src/session_admission.rs",
);
const error = readRequired("v3/crates/routecodex-v3-error/src/lib.rs");
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
  /read_json_payload\(request\)\.await[\s\S]*admit_v3_responses_session_after_json_parse[\s\S]*pending_endpoint_after_responses_admission/,
  "Responses handler must admit the explicit scope after the canonical JSON parser and before Runtime execution",
);
forbidMatch(
  server,
  /responses_session_admission_middleware|V3ResponsesAdmissionParsedPayload/,
  "Session admission must not create middleware JSON parsing or parsed-payload bypass owners",
);
requireMatch(
  server,
  /hold_response_body_admission_permit[\s\S]*body\.into_data_stream\(\)[\s\S]*Body::from_stream/,
  "Admission permit must be held by the HTTP response body lifetime",
);
requireMatch(
  admission,
  /same_present_identity\(&active\.session_id,\s*&scope\.session_id\)[\s\S]*\|\|[\s\S]*same_present_identity\([\s\S]*active\.conversation_id/,
  "Conflict must match either the explicit session or explicit conversation",
);
requireMatch(
  admission,
  /impl Drop for V3ResponsesSessionAdmissionPermit[\s\S]*\.active[\s\S]*\.remove\(&token\)/,
  "Permit drop must remove only its exact admission token",
);
requireMatch(
  error,
  /V3HttpBoundaryErrorKind::RequestInFlight[\s\S]*V3ErrorSourceKind::RequestConflict,\s*"request_in_flight"/,
  "Request overlap must enter the standard Error01-06 chain as request_in_flight",
);
requireMatch(
  error,
  /V3ErrorSourceKind::RequestConflict\s*=>\s*409/,
  "Request conflict must project HTTP 409",
);
requireMatch(
  server,
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
  server,
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
    /responses_same_listener_same_session_overlap_is_rejected_before_provider_send/,
    "Controlled provider overlap blackbox must exist",
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
if (
  typeof scripts["test:v3-responses-session-admission"] !== "string" ||
  !scripts["test:v3-responses-session-admission"].includes(
    "responses_client_drop_releases_same_session_before_provider_eof",
  )
) {
  failures.push(
    "Admission behavior gate must execute the controlled client-drop HTTP blackbox",
  );
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
