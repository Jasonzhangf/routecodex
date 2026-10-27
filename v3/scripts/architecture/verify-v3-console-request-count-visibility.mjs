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
// The scanned set is discovered from the crate's src tree, so a newly added
// lane cannot escape the guard by living in another file.
const emitterName = "emit_v3_observability_console_lines";

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

// Replace comment bodies and string/char literal contents with spaces, keeping
// every offset identical to the original source. This keeps parens, braces and
// the emitter name inside a comment or a string from being read as code.
function maskCommentsAndStrings(source) {
  const out = Array.from(source);
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  const blockCommentEnd = (from) => {
    let depth = 1;
    let i = from + 2;
    while (i < source.length - 1) {
      if (source[i] === "/" && source[i + 1] === "*") {
        depth += 1;
        i += 2;
      } else if (source[i] === "*" && source[i + 1] === "/") {
        depth -= 1;
        i += 2;
        if (depth === 0) return i;
      } else {
        i += 1;
      }
    }
    return -1;
  };
  // Find the opening quote of a (byte/raw) string literal beginning at `from`.
  // Returns { open, hashes } when it is a string, or null when `from` is an
  // identifier such as `b`, `r`, or a raw identifier `r#type`. `open` is the
  // index of the `"`, `hashes` the number of `#` for raw strings.
  const stringOpening = (from) => {
    let i = from;
    let hashes = 0;
    if (source[i] === "b") i += 1;
    if (source[i] === "r") {
      i += 1;
      while (source[i] === "#") {
        hashes += 1;
        i += 1;
      }
    }
    if (source[i] === '"') return { open: i, hashes };
    return null;
  };
  const stringEnd = (open, hashes) => {
    let i = open + 1;
    while (i < source.length) {
      if (hashes > 0) {
        if (source[i] === '"' && source.slice(i + 1, i + 1 + hashes) === "#".repeat(hashes)) {
          return i + hashes;
        }
        i += 1;
      } else if (source[i] === "\\") {
        i += 2;
      } else if (source[i] === '"') {
        return i;
      } else {
        i += 1;
      }
    }
    return -1;
  };
  const charEnd = (from) => {
    // A char literal is `'` + (escape | single char) + `'`; a lifetime like
    // `'static` is not. `from` is the opening quote index.
    if (source[from + 1] === "\\") {
      let i = from + 2;
      while (i < source.length && source[i] !== "'") i += 1;
      return i < source.length ? i : -1;
    }
    return source[from + 2] === "'" ? from + 2 : -1;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
    } else if (c === "/" && n === "*") {
      const end = blockCommentEnd(i);
      if (end === -1) return { masked: out.join(""), failed: true };
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "b" || c === "r") {
      const opening = stringOpening(i);
      if (opening === null) {
        i += 1;
        continue;
      }
      const end = stringEnd(opening.open, opening.hashes);
      if (end === -1) return { masked: out.join(""), failed: true };
      blank(i, end + 1);
      i = end + 1;
    } else if (c === "'") {
      const end = charEnd(i);
      if (end !== -1) {
        blank(i, end + 1);
        i = end + 1;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return { masked: out.join(""), failed: false };
}

// Discover the source files that reference the emitter, excluding test modules.
function discoverEmitterSources() {
  const srcRoot = path.join(root, "v3", "crates", "routecodex-v3-server", "src");
  if (!fs.existsSync(srcRoot)) {
    failures.push(`missing crate source tree: ${srcRoot}`);
    return [];
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "tests") continue;
        walk(full);
      } else if (entry.name.endsWith(".rs")) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        const source = readRequired(relative);
        if (!source.includes(emitterName)) continue;
        const { masked, failed } = maskCommentsAndStrings(source);
        if (failed) {
          failures.push(`${relative} has an unterminated comment or string literal`);
          continue;
        }
        if (masked.includes(`${emitterName}(`)) found.push(relative);
      }
    }
  };
  walk(srcRoot);
  found.sort();
  if (found.length === 0) {
    failures.push(`no source file under ${srcRoot} references ${emitterName}(`);
  }
  return found;
}

// Return the spans of every balanced `{ ... }` block in the masked source, plus
// whether the file's braces are balanced at all. Unbalanced input is a hard
// failure because it would make scope inference unreliable.
function braceBlocks(masked) {
  const stack = [];
  const blocks = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === "{") {
      stack.push(i);
    } else if (masked[i] === "}") {
      if (stack.length === 0) return { blocks, balanced: false };
      blocks.push({ open: stack.pop(), close: i });
    }
  }
  return { blocks, balanced: stack.length === 0 };
}

function innermostBlockContaining(blocks, index) {
  let best = null;
  for (const block of blocks) {
    if (block.open < index && index < block.close) {
      if (best === null || block.open > best.open) best = block;
    }
  }
  return best;
}

// A binding `let client_body_is_sse = <expr>.client_body.is_sse();` is the
// anthropic lane's intrinsic evidence. It is in scope at an emit iff it is
// declared before the emit and its innermost enclosing block also encloses the
// emit. This is Rust's own scoping rule, so renaming the response constructor
// or inserting a comment between the emit and the constructor cannot move it.
function anthropicBindingInScopeAt(masked, emitIndex) {
  const { blocks, balanced } = braceBlocks(masked);
  if (!balanced) return { inScope: false, ambiguous: true };
  const binding = /\blet\s+client_body_is_sse\s*=\s*[^;]*\.client_body\s*\.\s*is_sse\s*\(\s*\)\s*;/gu;
  for (const match of masked.matchAll(binding)) {
    if (match.index > emitIndex) break;
    const block = innermostBlockContaining(blocks, match.index);
    if (block === null) continue;
    if (emitIndex > block.open && emitIndex < block.close) {
      return { inScope: true, ambiguous: false };
    }
  }
  return { inScope: false, ambiguous: false };
}

// Parse the argument list of one emitter call by paren balancing. Returns the
// last argument's trimmed text, or null when the span is unbalanced or contains
// a nested emitter call (both of which must fail rather than silently pass).
function parseEmitterCallArgs(masked, nameIndex) {
  const open = nameIndex + emitterName.length;
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { lastArg: null, error: "unbalanced call parentheses" };
  const span = masked.slice(open + 1, close);
  if (span.includes(`${emitterName}(`)) {
    return { lastArg: null, error: "nested emitter call inside the argument list" };
  }
  // Split on top-level commas (depth 0 across (), [], {}).
  const segments = [];
  let segStart = 0;
  let p = 0;
  let b = 0;
  let k = 0;
  for (let i = 0; i < span.length; i += 1) {
    const ch = span[i];
    if (ch === "(") p += 1;
    else if (ch === ")") p -= 1;
    else if (ch === "[") b += 1;
    else if (ch === "]") b -= 1;
    else if (ch === "{") k += 1;
    else if (ch === "}") k -= 1;
    else if (ch === "," && p === 0 && b === 0 && k === 0) {
      segments.push(span.slice(segStart, i));
      segStart = i + 1;
    }
  }
  segments.push(span.slice(segStart));
  // A trailing comma leaves an empty final segment; the last real argument is
  // the one before it.
  while (segments.length > 0 && segments[segments.length - 1].trim() === "") segments.pop();
  const last = segments[segments.length - 1] ?? "";
  const trimmed = last.trim();
  return { lastArg: trimmed, error: null };
}

const emitterSources = discoverEmitterSources();
// The anthropic relay lane must never judge its client body by the presence of
// a stream observation: it populates that observation for the JSON closeout too,
// so is_none() is always false there and a JSON success would neither commit the
// count nor write its request.completed terminal. Ownership is the in-scope
// client_body_is_sse binding, not any neighbouring function name.
for (const relative of emitterSources) {
  const source = readRequired(relative);
  const { masked, failed } = maskCommentsAndStrings(source);
  if (failed) {
    failures.push(`${relative} has an unterminated comment or string literal`);
    continue;
  }
  const { balanced } = braceBlocks(masked);
  if (!balanced) {
    failures.push(`${relative} has unbalanced braces; scope inference would be unreliable`);
    continue;
  }
  let definitionsSkipped = 0;
  let callSitesInspected = 0;
  const occurrence = new RegExp(`${emitterName}\\s*\\(`, "gu");
  for (const match of masked.matchAll(occurrence)) {
    const linePrefix = masked.slice(masked.lastIndexOf("\n", match.index) + 1, match.index);
    if (/\bfn\s*$/u.test(linePrefix)) {
      definitionsSkipped += 1;
      continue;
    }
    callSitesInspected += 1;
    const line = source.slice(0, match.index).split("\n").length;
    const parsed = parseEmitterCallArgs(masked, match.index);
    if (parsed.error !== null) {
      failures.push(
        `${relative}:${line} console emitter call could not be parsed (${parsed.error}); refusing to pass`,
      );
      continue;
    }
    const includeUsage = parsed.lastArg;
    if (!allowedIncludeUsage.includes(includeUsage)) {
      failures.push(
        `${relative} console emitter must pass the client response body stream judgment (client_body.is_sse() or stream_observation.is_none()) as include_usage, got "${includeUsage}"`,
      );
      continue;
    }
    const { inScope, ambiguous } = anthropicBindingInScopeAt(masked, match.index);
    if (ambiguous) {
      failures.push(`${relative}:${line} cannot determine the emitter lane; refusing to pass`);
      continue;
    }
    if (
      inScope &&
      includeUsage !== "!client_body_is_sse" &&
      includeUsage !== "!output.client_body.is_sse()" &&
      includeUsage !== "!relay_output.client_body.is_sse()"
    ) {
      failures.push(
        `${relative}:${line} anthropic relay console emitter must judge the client response body (client_body.is_sse()), not the stream observation; got "${includeUsage}"`,
      );
    }
  }
  // Self-exporting consistency: every call-shaped occurrence of the emitter in
  // code (comments and strings already blanked) must be accounted for as either
  // a definition or an inspected call site. A `use` import of the function is
  // not a call, so it must not trip this check.
  const totalOccurrences = (masked.match(new RegExp(`${emitterName}\\s*\\(`, "g")) ?? []).length;
  if (totalOccurrences !== definitionsSkipped + callSitesInspected) {
    failures.push(
      `${relative} emitter scan may be incomplete: found ${totalOccurrences} occurrences of ${emitterName}(, accounted for ${definitionsSkipped + callSitesInspected} (${definitionsSkipped} definitions skipped, ${callSitesInspected} call sites inspected)`,
    );
  }
}

if (failures.length > 0) {
  console.error("[verify:v3-console-request-count-visibility] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[verify:v3-console-request-count-visibility] PASS");
