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

// Source anchor: every console emitter that can front a client response body
// must gate the success commit on whether that body is a stream, so the commit
// moves to the stream terminal instead of running before the first SSE byte.
// The scanned set is every product source file that calls the emitter, so a
// newly added lane cannot escape the guard by living in another file.
const emitterSources = [
  "v3/crates/routecodex-v3-server/src/executors.rs",
  "v3/crates/routecodex-v3-server/src/endpoint_handlers.rs",
  "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
];
// Emitter call sites accept any of the declared client-body stream judgments:
// the typed client_body.is_sse() form for lanes that populate stream_observation
// for both closeouts, and stream_observation.is_none() / !is_sse for the rest.
const allowedIncludeUsage = [
  "!client_body_is_sse",
  "!output.client_body.is_sse()",
  "!relay_output.client_body.is_sse()",
  "output.stream_observation.is_none()",
  "relay_output.stream_observation.is_none()",
  "!is_sse",
];
// The Anthropic relay lane must never judge its client body by the presence of a
// stream observation: it populates that observation for the JSON closeout too,
// so is_none() is always false there and a JSON success would neither commit the
// count nor write its request.completed terminal. A lane owns the emitter that
// hands its output to that lane's own response constructor; this anchor is the
// lane's real projection point, unlike a swappable neighbour helper.
const laneResponseConstructor = /(?<lane>\w+)_relay_output_response\(/u;
for (const relative of emitterSources) {
  const source = readRequired(relative);
  // Call sites close with `);` and a definition signature opens with `fn ...(`.
  // The body of the definition also contains `);`-terminated calls, so the
  // definition itself must be skipped explicitly or it captures its own body.
  const pattern = /emit_v3_observability_console_lines\(([\s\S]*?)\n\s*\);/gu;
  for (const match of source.matchAll(pattern)) {
    const linePrefix = source.slice(source.lastIndexOf("\n", match.index) + 1, match.index);
    if (/\bfn\s*$/u.test(linePrefix)) {
      continue;
    }
    const includeUsage = (match[1].split("\n").filter((line) => line.trim()).pop() ?? "")
      .trim()
      .replace(/,$/u, "");
    if (!allowedIncludeUsage.includes(includeUsage)) {
      failures.push(
        `${relative} console emitter must pass the client response body stream judgment (client_body.is_sse() or stream_observation.is_none()) as include_usage, got "${includeUsage}"`,
      );
      continue;
    }
    // The lane this emitter belongs to is the first response constructor after
    // it; an emitter that no lane constructor follows (the direct lane) has no
    // lane-specific requirement beyond the allowlist above.
    const after = source.slice(match.index + match[0].length);
    const lane = after.match(laneResponseConstructor)?.groups?.lane;
    if (
      lane === "anthropic" &&
      includeUsage !== "!client_body_is_sse" &&
      includeUsage !== "!output.client_body.is_sse()" &&
      includeUsage !== "!relay_output.client_body.is_sse()"
    ) {
      failures.push(
        `${relative} anthropic relay console emitter must judge the client response body (client_body.is_sse()), not the stream observation; got "${includeUsage}"`,
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
