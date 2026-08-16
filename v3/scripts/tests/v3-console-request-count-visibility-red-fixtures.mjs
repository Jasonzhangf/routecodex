#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-console-request-count-visibility.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/request_id.rs",
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
  "docs/architecture/function-map.yml",
  "docs/architecture/mainline-call-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests/v3.console_request_count_visibility.mainline.yml",
];
const cases = [
  {
    name: "typed allocation drops daily count",
    path: "v3/crates/routecodex-v3-server/src/request_id.rs",
    mutate: (source) =>
      source.replace("    pub(crate) daily_count: u64,", "    pub(crate) daily_count_removed: u64,"),
    diagnostic: /must carry request_id, total_count, and daily_count/u,
  },
  {
    name: "aggregate listeners restore independent request counter locks",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source
        .replace(
          "    let request_counter = Arc::new(Mutex::new(V3RequestIdCounter::new()));\n",
          "",
        )
        .replace(
          "            request_counter: Arc::clone(&request_counter),",
          "            request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),",
        ),
    diagnostic: /must share one request counter handle|must not create one request counter lock per port/u,
  },
  {
    name: "response headline stops rendering request count",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) => {
      const start = source.indexOf("fn render_v3_response_console_block(");
      const tail = source.slice(start);
      const changed = tail.replace(
        "format_v3_console_request_count(headline.request_identity)",
        '"[#removed]"',
      );
      return source.slice(0, start) + changed;
    },
    diagnostic: /Response headline must render the same typed request count/u,
  },
  {
    name: "count formatter parses request id",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "pub(crate) fn format_v3_console_request_count(identity: &V3AllocatedRequestIdentity) -> String {",
        "pub(crate) fn format_v3_console_request_count(identity: &V3AllocatedRequestIdentity) -> String {\n    let _forbidden = identity.request_id.rsplit('-');",
      ),
    diagnostic: /must not parse the long request id/u,
  },
  {
    name: "pre-route placeholder request block is restored",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "pub(crate) fn emit_v3_request_route_hit_console_line_for_observability(",
        "fn emit_v3_request_received_console_line() {}\n\npub(crate) fn emit_v3_request_route_hit_console_line_for_observability(",
      ),
    diagnostic: /must not emit a duplicate pre-route request block/u,
  },
  {
    name: "request identity owner drifts to an unregistered feature",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "    owner_feature_id: v3.console_request_count_visibility\n    owner_crate: routecodex-v3-server\n    owner_node: V3RequestCounter01AggregateOwned",
        "    owner_feature_id: v3.server_request_identity_scope\n    owner_crate: routecodex-v3-server\n    owner_node: V3RequestCounter01AggregateOwned",
      ),
    diagnostic: /single registered count feature/u,
  },
  {
    name: "count mainline binds aggregate allocation to a struct instead of a constructor",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replace(
        "callee_symbol: V3RequestIdCounter::new",
        "callee_symbol: V3RequestIdCounter",
      ),
    diagnostic: /must bind aggregate allocation to callable V3RequestIdCounter::new/u,
  },
  {
    name: "count formatter claims console terminal output ownership",
    path: "docs/architecture/mainline-call-map.yml",
    mutate: (source) => {
      const chainStart = source.indexOf(
        "chain_id: v3.console_request_count_visibility.mainline",
      );
      const timingStart = source.indexOf(
        "chain_id: v3.runtime_timing_observability.mainline",
        chainStart,
      );
      const chain = source.slice(chainStart, timingStart);
      const mutated = chain.replace(
        "produces: []",
        "produces: [v3.console.terminal_output]",
      );
      return source.slice(0, chainStart) + mutated + source.slice(timingStart);
    },
    diagnostic: /must not claim terminal output ownership/u,
  },
  {
    name: "count owner drops request identity write truth",
    path: "docs/architecture/function-map.yml",
    mutate: (source) =>
      source.replace(
        "    writes:\n    - v3.server.request_identity",
        "    writes: []",
      ),
    diagnostic: /must write only v3.server.request_identity/u,
  },
  {
    name: "count owner claims console terminal output write",
    path: "docs/architecture/function-map.yml",
    mutate: (source) =>
      source.replace(
        "    writes:\n    - v3.server.request_identity",
        "    writes:\n    - v3.server.request_identity\n    - v3.console.terminal_output",
      ),
    diagnostic: /must write only v3.server.request_identity/u,
  },
  {
    name: "global count function map drops a mainline binding",
    path: "docs/architecture/function-map.yml",
    mutate: (source) =>
      source.replace("  - v3-console-count-04\n", ""),
    diagnostic: /global function map must bind request count edges 01 through 04 in order/u,
  },
  {
    name: "V3 count function map reorders mainline bindings",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace(
        "  - v3-console-count-02\n  - v3-console-count-03",
        "  - v3-console-count-03\n  - v3-console-count-02",
      ),
    diagnostic: /V3 function map must bind request count edges 01 through 04 in order/u,
  },
  {
    name: "global count verification map drops a mainline binding",
    path: "docs/architecture/verification-map.yml",
    mutate: (source) =>
      source.replace("  - v3-console-count-04\n", ""),
    diagnostic: /global verification map must bind request count edges 01 through 04 in order/u,
  },
  {
    name: "V3 count verification map reorders mainline bindings",
    path: "docs/architecture/v3-verification-map.yml",
    mutate: (source) =>
      source.replace(
        "  - v3-console-count-02\n  - v3-console-count-03",
        "  - v3-console-count-03\n  - v3-console-count-02",
      ),
    diagnostic: /V3 verification map must bind request count edges 01 through 04 in order/u,
  },
  {
    name: "build skips request count verifier",
    path: "package.json",
    mutate: (source) => {
      const parsed = JSON.parse(source);
      parsed.scripts["build:v3-cli"] = parsed.scripts["build:v3-cli"].replace(
        "npm run verify:v3-console-request-count-visibility && ",
        "",
      );
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    diagnostic: /build:v3-cli must run verify:v3-console-request-count-visibility/u,
  },
  {
    name: "CI skips canonical V3 verification",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll("        run: npm --prefix v3 run verify:ci\n", ""),
    diagnostic: /CI must dispatch the canonical V3 verification stack/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-console-count-red-"));
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
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
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
  console.error("[test:v3-console-request-count-visibility-red-fixtures] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-console-request-count-visibility-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
