#!/usr/bin/env node

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-debug-payload-budget.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-debug/src/lib.rs",
  "v3/crates/routecodex-v3-debug/tests/debug_runtime_contract.rs",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "docs/architecture/function-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
];
const cases = [
  {
    name: "final serialized byte check is removed",
    path: "v3/crates/routecodex-v3-debug/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "if serialized_bytes.len() <= V3_DEBUG_MAX_PAYLOAD_BYTES {",
        "if true {",
      ),
    diagnostic: /final serialized artifact/u,
  },
  {
    name: "bounded stream capture becomes an unbounded string",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replaceAll(
        "Arc<Mutex<V3DebugBoundedTextCapture>>",
        "Arc<Mutex<String>>",
      ),
    diagnostic: /Debug-owned bounded capture/u,
  },
  {
    name: "Direct SSE success keepalive is restored",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) => {
      const start = source.indexOf(
        "fn responses_direct_output_response_with_console(",
      );
      const tail = source.slice(start);
      const changed = tail.replace(
        ".body(v3_client_sse_body(stream, None))",
        ".body(v3_client_sse_body(stream, Some(Duration::from_millis(1))))",
      );
      return source.slice(0, start) + changed;
    },
    diagnostic: /without keepalive injection/u,
  },
  {
    name: "missing HOME silently disables persistence again",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        'ok_or_else(|| "codex sample filesystem requires HOME".to_string())?',
        'unwrap_or_else(|| ".".into())',
      ),
    diagnostic: /reject missing or blank HOME/u,
  },
  {
    name: "build skips the payload budget verifier",
    path: "package.json",
    mutate: (source) => {
      const parsed = JSON.parse(source);
      parsed.scripts["build:v3-cli"] = parsed.scripts["build:v3-cli"].replace(
        "npm run verify:v3-debug-payload-budget && ",
        "",
      );
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    diagnostic: /build:v3-cli must run verify:v3-debug-payload-budget/u,
  },
  {
    name: "CI skips payload budget red fixtures",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll(
        "        run: npm run test:v3-debug-payload-budget-red-fixtures\n",
        "",
      ),
    diagnostic: /CI must run the V3 debug payload budget red fixtures/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-debug-budget-red-"));
  try {
    for (const relative of copied) {
      cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, "utf8");
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0) {
      failures.push(`${testCase.name}: verifier unexpectedly passed`);
    } else if (!testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("[test:v3-debug-payload-budget-red-fixtures] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-debug-payload-budget-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
