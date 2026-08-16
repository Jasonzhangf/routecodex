#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const installedV3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const explicitSourceRoot = String(process.env.ROUTECODEX_V3_SOURCE_ROOT ?? "").trim();
const root = explicitSourceRoot
  ? path.resolve(explicitSourceRoot)
  : process.env.ROUTECODEX_V3_ADMISSION_WORKSPACE === "1"
    ? path.dirname(installedV3Root)
    : path.join(installedV3Root, "build-contracts", "architecture-admission", "repo");
const v3Root = explicitSourceRoot ? path.join(root, "v3") : installedV3Root;
const failures = [];

function readRequired(relative) {
  const file = relative.startsWith("v3/")
    ? path.join(v3Root, relative.slice(3))
    : path.join(root, relative);
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

function parseYaml(source, label) {
  try {
    return YAML.parse(source) ?? {};
  } catch (error) {
    failures.push(`${label} is not valid YAML: ${error.message}`);
    return {};
  }
}

const server = readRequired("v3/crates/routecodex-v3-server/src/lib.rs");
const requestIdModule = readRequired(
  "v3/crates/routecodex-v3-server/src/request_id.rs",
);
const consoleImpl = readRequired(
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
);
const production =
  server.split("#[cfg(test)]")[0] +
  "\n" +
  consoleImpl.split("#[cfg(test)]")[0];
const v3FunctionMap = readRequired("docs/architecture/v3-function-map.yml");
const functionMap = readRequired("docs/architecture/function-map.yml");
const v3ResourceMap = readRequired("docs/architecture/v3-resource-operation-map.yml");
const resourceMap = readRequired("docs/architecture/resource-operation-map.yml");
const v3MainlineMap = readRequired("docs/architecture/v3-mainline-call-map.yml");
const mainlineMap = readRequired("docs/architecture/mainline-call-map.yml");
const v3VerificationMap = readRequired("docs/architecture/v3-verification-map.yml");
const verificationMap = readRequired("docs/architecture/verification-map.yml");
const manifest = readRequired(
  "docs/architecture/manifests/v3.console_request_count_visibility.mainline.yml",
);
const workflow = readRequired(".github/workflows/test.yml");
let packageJson = {};
try {
  packageJson = JSON.parse(fs.readFileSync(path.join(v3Root, "package.json"), "utf8"));
} catch (error) {
  failures.push(`package.json is not valid JSON: ${error.message}`);
}

requireMatch(
  requestIdModule,
  /struct V3AllocatedRequestIdentity\s*\{[\s\S]*request_id:\s*String,[\s\S]*total_count:\s*u64,[\s\S]*daily_count:\s*u64,/,
  "V3AllocatedRequestIdentity must carry request_id, total_count, and daily_count",
);
requireMatch(
  requestIdModule,
  /fn next_request_identity\([\s\S]*Result<V3AllocatedRequestIdentity,\s*String>[\s\S]*V3AllocatedRequestIdentity\s*\{[\s\S]*total_count:\s*self\.state\.total_count,[\s\S]*daily_count:\s*self\.state\.window_count,/,
  "V3RequestIdCounter must return counts from the same atomic allocation",
);
requireMatch(
  production,
  /let request_counter = Arc::new\(Mutex::new\(V3RequestIdCounter::new\(\)\)\);[\s\S]*for \(server, listener, addr\) in bound \{[\s\S]*request_counter: Arc::clone\(&request_counter\),/,
  "V3 aggregate listeners must share one request counter handle",
);
forbidMatch(
  production,
  /for \(server, listener, addr\) in bound \{[\s\S]{0,1500}request_counter: Arc::new\(Mutex::new\(V3RequestIdCounter::new\(\)\)\),/,
  "V3 listener construction must not create one request counter lock per port",
);
requireMatch(
  production,
  /fn format_v3_console_request_count\([\s\S]*identity\.total_count[\s\S]*identity\.daily_count[\s\S]*V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH/,
  "Console request count formatter must consume typed total and daily counts",
);
requireMatch(
  production,
  /fn render_v3_request_console_block\([\s\S]*V3ConsoleRequestHeadline<'_>[\s\S]*format_v3_console_request_count\(headline\.request_identity\)/,
  "Request headline must render the typed request count",
);
requireMatch(
  production,
  /fn render_v3_response_console_block\([\s\S]*V3ConsoleResponseHeadline<'_>[\s\S]*format_v3_console_request_count\(headline\.request_identity\)/,
  "Response headline must render the same typed request count",
);
forbidMatch(
  production,
  /format_v3_console_request_count[\s\S]{0,800}(?:rsplit|split_once|Regex)/,
  "Console request count must not parse the long request id",
);
forbidMatch(
  production,
  /emit_v3_request_received_console_line/,
  "Console must not emit a duplicate pre-route request block with placeholder route/model truth",
);

for (const [source, label] of [
  [v3MainlineMap, "V3 mainline map"],
  [mainlineMap, "global mainline map"],
]) {
  const parsed = parseYaml(source, label);
  const chain = (parsed.chains ?? []).find(
    (candidate) =>
      candidate?.chain_id === "v3.console_request_count_visibility.mainline",
  );
  const edges = chain?.edges ?? [];
  const constructor = edges.find(
    (edge) => edge?.step_id === "v3-console-count-01",
  );
  if (
    constructor?.caller_symbol !== "spawn_v3_server_aggregate" ||
    constructor?.callee_symbol !== "V3RequestIdCounter::new"
  ) {
    failures.push(
      `${label} must bind aggregate allocation to callable V3RequestIdCounter::new`,
    );
  }
  for (const stepId of ["v3-console-count-03", "v3-console-count-04"]) {
    const edge = edges.find((candidate) => candidate?.step_id === stepId);
    const produces = edge?.resource_flow?.produces;
    const sideChannelWrites = edge?.resource_flow?.side_channel_writes;
    if (
      !Array.isArray(produces) ||
      produces.length !== 0 ||
      !Array.isArray(sideChannelWrites) ||
      sideChannelWrites.length !== 0
    ) {
      failures.push(
        `${label} ${stepId} must not claim terminal output ownership`,
      );
    }
  }
}

const globalFunctionMap = parseYaml(functionMap, "global function map");
const countFeature = (globalFunctionMap.owners ?? []).find(
  (owner) => owner?.feature_id === "v3.console_request_count_visibility",
);
if (
  !countFeature ||
  !Array.isArray(countFeature?.resource_bindings?.reads) ||
  JSON.stringify(countFeature.resource_bindings.reads) !==
    JSON.stringify(["v3.server.request_identity"])
) {
  failures.push(
    "global function map count feature must read only v3.server.request_identity",
  );
}
if (
  !countFeature ||
  !Array.isArray(countFeature?.resource_bindings?.writes) ||
  JSON.stringify(countFeature.resource_bindings.writes) !==
    JSON.stringify(["v3.server.request_identity"])
) {
  failures.push(
    "global function map count feature must write only v3.server.request_identity",
  );
}
for (const forbiddenWrite of [
  "console.terminal_output",
  "v3.console.terminal_output",
  "request.normal_payload",
  "response.client_payload",
]) {
  if (!countFeature?.resource_bindings?.forbidden?.includes(forbiddenWrite)) {
    failures.push(
      `global function map count feature must forbid ${forbiddenWrite}`,
    );
  }
}

const countStepIds = [
  "v3-console-count-01",
  "v3-console-count-02",
  "v3-console-count-03",
  "v3-console-count-04",
];
for (const [source, collection, label] of [
  [functionMap, "owners", "global function map"],
  [v3FunctionMap, "features", "V3 function map"],
  [verificationMap, "verification", "global verification map"],
  [v3VerificationMap, "features", "V3 verification map"],
]) {
  const parsed = parseYaml(source, label);
  const feature = (parsed[collection] ?? []).find(
    (candidate) => candidate?.feature_id === "v3.console_request_count_visibility",
  );
  if (
    JSON.stringify(feature?.mainline_bindings ?? []) !==
    JSON.stringify(countStepIds)
  ) {
    failures.push(`${label} must bind request count edges 01 through 04 in order`);
  }
}

for (const [source, label] of [
  [v3FunctionMap, "V3 function map"],
  [functionMap, "global function map"],
  [v3VerificationMap, "V3 verification map"],
  [verificationMap, "global verification map"],
]) {
  requireMatch(
    source,
    /feature_id:\s*v3\.console_request_count_visibility\b/,
    `${label} must register v3.console_request_count_visibility`,
  );
}
for (const [source, label] of [
  [v3ResourceMap, "V3 resource map"],
  [resourceMap, "global resource map"],
]) {
  requireMatch(
    source,
    /resource_id:\s*v3\.server\.request_identity\b/,
    `${label} must register v3.server.request_identity`,
  );
  requireMatch(
    source,
    /resource_id:\s*v3\.server\.request_identity\b[\s\S]{0,700}lifecycle:\s*v3\.console_request_count_visibility\.mainline\b[\s\S]{0,700}owner_feature_id:\s*v3\.console_request_count_visibility\b/,
    `${label} must bind request identity allocation and projection to the single registered count feature`,
  );
}
forbidMatch(
  `${v3FunctionMap}\n${functionMap}\n${v3VerificationMap}`,
  /v3\.console_request_count_visibility[\s\S]{0,500}(?:projection-only|Projection-only consumer)/,
  "Request count feature must not claim projection-only ownership while owning the typed allocation extension",
);
for (const [source, label] of [
  [v3MainlineMap, "V3 mainline map"],
  [mainlineMap, "global mainline map"],
  [manifest, "request count lifecycle manifest"],
]) {
  requireMatch(
    source,
    /v3\.console_request_count_visibility\.mainline/,
    `${label} must register the request count lifecycle`,
  );
}

const scripts = packageJson.scripts ?? {};
for (const scriptName of [
  "verify:v3-console-request-count-visibility",
  "test:v3-console-request-count-visibility-red-fixtures",
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
    !scripts[scriptName].includes("verify:v3-console-request-count-visibility")
  ) {
    failures.push(`${scriptName} must run verify:v3-console-request-count-visibility`);
  }
}
requireMatch(workflow, /npm --prefix v3 run verify:ci/, "CI must dispatch the canonical V3 verification stack");

if (failures.length > 0) {
  console.error("[verify:v3-console-request-count-visibility] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-console-request-count-visibility] PASS");
