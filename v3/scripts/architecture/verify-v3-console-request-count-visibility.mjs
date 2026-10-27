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
  : path.dirname(installedV3Root);
const failures = [];

function readRequired(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    failures.push(`missing required source: ${relative}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function parseYaml(source, label) {
  try {
    return YAML.parse(source) ?? {};
  } catch (error) {
    failures.push(`${label} is not valid YAML: ${error.message}`);
    return {};
  }
}

const v3FunctionMap = readRequired("docs/architecture/v3-function-map.yml");
const functionMap = readRequired("docs/architecture/function-map.yml");
const v3ResourceMap = readRequired("docs/architecture/v3-resource-operation-map.yml");
const resourceMap = readRequired("docs/architecture/resource-operation-map.yml");
const v3MainlineMap = readRequired("docs/architecture/v3-mainline-call-map.yml");
const mainlineMap = readRequired("docs/architecture/mainline-call-map.yml");
const v3VerificationMap = readRequired("docs/architecture/v3-verification-map.yml");
const verificationMap = readRequired("docs/architecture/verification-map.yml");

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

for (const [source, collection, label] of [
  [v3ResourceMap, "resources", "V3 resource map"],
  [resourceMap, "resources", "global resource map"],
]) {
  const parsed = parseYaml(source, label);
  const resource = (parsed[collection] ?? []).find(
    (candidate) => candidate?.resource_id === "v3.server.request_identity",
  );
  if (!resource) {
    failures.push(`${label} must register v3.server.request_identity`);
  }
  if (resource?.lifecycle !== "v3.console_request_count_visibility.mainline") {
    failures.push(
      `${label} request identity must use the request count lifecycle`,
    );
  }
  if (resource?.owner_feature_id !== "v3.console_request_count_visibility") {
    failures.push(
      `${label} request identity must be owned by the single registered count feature`,
    );
  }
}

// Success-only count contract: allocation reserves the sequence and only the
// success commit may write totalCount/windowCount. Error terminals never count.
for (const [source, collection, label, builders] of [
  [functionMap, "owners", "global function map", ["commit_request_success"]],
  [
    v3FunctionMap,
    "features",
    "V3 function map",
    ["V3RequestIdCounter::commit_request_success"],
  ],
]) {
  const parsed = parseYaml(source, label);
  const feature = (parsed[collection] ?? []).find(
    (candidate) => candidate?.feature_id === "v3.console_request_count_visibility",
  );
  const declared = [
    ...(Array.isArray(feature?.canonical_builders) ? feature.canonical_builders : []),
    ...(Array.isArray(feature?.entry_symbols) ? feature.entry_symbols : []),
  ];
  for (const builder of builders) {
    if (!declared.includes(builder)) {
      failures.push(`${label} must declare the success commit ${builder}`);
    }
  }
}

for (const [source, collection, label] of [
  [v3ResourceMap, "resources", "V3 resource map"],
  [resourceMap, "resources", "global resource map"],
]) {
  const parsed = parseYaml(source, label);
  const resource = (parsed[collection] ?? []).find(
    (candidate) => candidate?.resource_id === "v3.server.request_identity",
  );
  const writers = Array.isArray(resource?.allowed_writers)
    ? resource.allowed_writers
    : [];
  if (!writers.includes("V3RequestIdCounter::commit_request_success")) {
    failures.push(
      `${label} request identity must allow the success commit writer V3RequestIdCounter::commit_request_success`,
    );
  }
}

for (const [source, collection, label] of [
  [verificationMap, "verification", "global verification map"],
  [v3VerificationMap, "features", "V3 verification map"],
]) {
  const parsed = parseYaml(source, label);
  const feature = (parsed[collection] ?? []).find(
    (candidate) => candidate?.feature_id === "v3.console_request_count_visibility",
  );
  const positive = (Array.isArray(feature?.required_positive)
    ? feature.required_positive
    : []
  ).join("\n");
  const negative = (Array.isArray(feature?.required_negative)
    ? feature.required_negative
    : []
  ).join("\n");
  if (!/only when the allocated identity commits/u.test(positive)) {
    failures.push(
      `${label} must require that counts increment only on a success commit`,
    );
  }
  if (
    !/SSE lanes commit the success count only when the committed stream reaches its completion terminal/u.test(
      positive,
    )
  ) {
    failures.push(
      `${label} must require that SSE lanes commit only at the stream completion terminal`,
    );
  }
  if (!/Error terminals[^.]*never increment/u.test(negative)) {
    failures.push(`${label} must forbid count increments on error terminals`);
  }
  if (!/must not commit the same request twice/u.test(negative)) {
    failures.push(`${label} must forbid double-committing one request`);
  }
}

// Source anchor: every console emitter that can front a streaming relay lane
// must gate the success commit on the absent stream observation, so the commit
// moves to the stream terminal instead of running before the first SSE byte.
for (const source of [
  readRequired("v3/crates/routecodex-v3-server/src/executors.rs"),
  readRequired("v3/crates/routecodex-v3-server/src/endpoint_handlers.rs"),
]) {
  const pattern = /emit_v3_observability_console_lines\(([\s\S]*?)\n\s*\);/gu;
  for (const match of source.matchAll(pattern)) {
    const includeUsage = (match[1].split("\n").filter((line) => line.trim()).pop() ?? "")
      .trim()
      .replace(/,$/u, "");
    if (
      includeUsage !== "output.stream_observation.is_none()" &&
      includeUsage !== "relay_output.stream_observation.is_none()" &&
      includeUsage !== "!is_sse"
    ) {
      failures.push(
        `streaming console emitter must pass stream_observation.is_none() as include_usage, got "${includeUsage}"`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("[verify:v3-console-request-count-visibility] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-console-request-count-visibility] PASS");
