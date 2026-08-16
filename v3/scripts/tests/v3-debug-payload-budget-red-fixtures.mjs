#!/usr/bin/env node

// V3 debug sample-fidelity red fixtures: reintroducing truncation or
// placeholder machinery must fail the verifier.

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
  "v3/crates/routecodex-v3-debug/src/sample_store.rs",
  "v3/crates/routecodex-v3-debug/tests/debug_runtime_contract.rs",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
  "v3/crates/routecodex-v3-server/src/frame_builders.rs",
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
  "v3/crates/routecodex-v3-config/src/types.rs",
  "v3/crates/routecodex-v3-config/src/validate.rs",
  "docs/architecture/function-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
];
const cases = [
  {
    name: "oversized-string truncation placeholder is reintroduced",
    path: "v3/crates/routecodex-v3-debug/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "pub const V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR: &str =",
        "const ROUTECODEX_DEBUG_TRUNCATED_STRING: &str = \"forbidden\";\npub const V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR: &str =",
      ),
    diagnostic: /must not contain any truncation or placeholder machinery/u,
  },
  {
    name: "array omitted-items placeholder is reintroduced",
    path: "v3/crates/routecodex-v3-debug/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "pub const V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR: &str =",
        "const ROUTECODEX_DEBUG_OMITTED_ARRAY_ITEMS: &str = \"forbidden\";\npub const V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR: &str =",
      ),
    diagnostic: /must not contain any truncation or placeholder machinery/u,
  },
  {
    name: "stream capture truncation is reintroduced",
    path: "v3/crates/routecodex-v3-debug/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "pub fn append(&mut self, bytes: &[u8]) {\n        self.total_bytes = self.total_bytes.saturating_add(bytes.len());\n        self.bytes.extend_from_slice(bytes);\n    }",
        "pub fn append(&mut self, bytes: &[u8]) {\n        self.total_bytes = self.total_bytes.saturating_add(bytes.len());\n        self.bytes.extend_from_slice(&bytes[..bytes.len().min(48 * 1024)]);\n        let _ = \"ROUTECODEX_DEBUG_STREAM_TRUNCATED\";\n    }",
      ),
    diagnostic: /must not contain any truncation or placeholder machinery/u,
  },
  {
    name: "Direct SSE success keepalive is removed again",
    path: "v3/crates/routecodex-v3-server/src/frame_builders.rs",
    mutate: (source) => {
      const start = source.indexOf(
        "fn responses_direct_output_response_with_console(",
      );
      const tail = source.slice(start);
      const changed = tail.replace(
        ".body(v3_client_sse_body(stream, keepalive))",
        ".body(v3_client_sse_body(stream, None))",
      );
      return source.slice(0, start) + changed;
    },
    diagnostic: /must not pass keepalive=None for success streams/u,
  },
  {
    name: "build skips the sample-fidelity verifier",
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
    name: "CI skips canonical V3 verification",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll("        run: npm --prefix v3 run verify:ci\n", ""),
    diagnostic: /CI must dispatch the canonical V3 verification stack/u,
  },
  {
    name: "codex-sample retention is lowered below 200",
    path: "v3/crates/routecodex-v3-debug/src/sample_store.rs",
    mutate: (source) =>
      source.replace(
        "pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 200;",
        "pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 100;",
      ),
    diagnostic: /must default to 200 requests/u,
  },
  {
    name: "config compilation authorizes live samples",
    path: "v3/crates/routecodex-v3-config/src/validate.rs",
    mutate: (source) =>
      source.replace(
        "codex_samples: false,",
        "codex_samples: true,",
      ),
    diagnostic: /must not authorize live codex samples/u,
  },
  {
    name: "server reimplements its own sample persistence",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      source.replace(
        "fn persist_v3_codex_sample_payload(",
        "fn persist_v3_codex_sample_payload_unchecked(\n    state: &V3ListenerState,\n    entry_protocol: &str,\n    endpoint: &str,\n    request_id: &str,\n    file_name: &str,\n    payload: &Value,\n) -> Result<(), String> {\n    let port_root = resolve_v3_codex_samples_root()?;\n    let dir = port_root.join(encode_v3_codex_sample_path_segment(request_id));\n    let _ = dir;\n    Ok(())\n}\n\nfn persist_v3_codex_sample_payload(",
      ),
    diagnostic: /must not reimplement codex-sample persistence/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-debug-fidelity-red-"));
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
  `[test:v3-debug-payload-budget-red-fixtures] PASS (${cases.length} forbidden truncation/placeholder mutations rejected)`,
);
