#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const verifier = resolve(
  repo,
  "v3/scripts/architecture/verify-v3-console-request-count-visibility.mjs",
);
const copied = [
  "docs/architecture/function-map.yml",
  "docs/architecture/mainline-call-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
  "v3/crates/routecodex-v3-server/src/endpoint_handlers.rs",
  "v3/crates/routecodex-v3-server/src/executors.rs",
  "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
];
const cases = [
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
    name: "V3 count function map drops the success commit symbol",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace("  - V3RequestIdCounter::commit_request_success\n", ""),
    diagnostic: /must declare the success commit V3RequestIdCounter::commit_request_success/u,
  },
  {
    name: "global count function map drops the success commit builder",
    path: "docs/architecture/function-map.yml",
    mutate: (source) => source.replace("  - commit_request_success\n", ""),
    diagnostic: /must declare the success commit commit_request_success/u,
  },
  {
    name: "V3 resource map drops the success commit writer",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        ", V3RequestIdCounter::commit_request_success]",
        "]",
      ),
    diagnostic: /must allow the success commit writer V3RequestIdCounter::commit_request_success/u,
  },
  {
    name: "V3 count verification map allows allocation to increment counts",
    path: "docs/architecture/v3-verification-map.yml",
    mutate: (source) =>
      source.replace(
        "  - totalCount and windowCount increment only when the allocated identity commits one success terminal.",
        "  - totalCount and windowCount increment during identity allocation.",
      ),
    diagnostic: /must require that counts increment only on a success commit/u,
  },
  {
    name: "V3 count verification map allows error terminal increments",
    path: "docs/architecture/v3-verification-map.yml",
    mutate: (source) =>
      source.replace(
        "  - Error terminals (admission rejection, error frame, provider exhaustion, SSE failure or disconnect) must never increment totalCount or windowCount.",
        "  - Error terminals may increment totalCount or windowCount.",
      ),
    diagnostic: /must forbid count increments on error terminals/u,
  },
  {
    name: "V3 count verification map allows double-committing one request",
    path: "docs/architecture/v3-verification-map.yml",
    mutate: (source) =>
      source.replace(
        "  - Provider retries, provider switches, continuation frames, and a repeated completion must not commit the same request twice.",
        "  - Provider retries, provider switches, continuation frames, and a repeated completion may commit the same request twice.",
      ),
    diagnostic: /must forbid double-committing one request/u,
  },
  {
    name: "V3 count verification map allows SSE drop to count",
    path: "docs/architecture/v3-verification-map.yml",
    mutate: (source) =>
      source.replace(
        "  - Relay and Direct SSE lanes commit the success count only when the committed stream reaches its completion terminal, so a dropped or disconnected stream never counts.",
        "  - Relay and Direct SSE lanes commit the success count when the stream is handed to the client, including a dropped or disconnected stream.",
      ),
    diagnostic:
      /must require that SSE lanes commit only at the stream completion terminal/u,
  },
  {
    name: "anthropic relay SSE emitter commits before the stream terminal",
    path: "v3/crates/routecodex-v3-server/src/executors.rs",
    mutate: (source) =>
      source.replace(
        "                !client_body_is_sse,\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
        "                true,\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
      ),
    diagnostic:
      /console emitter must pass the client response body stream judgment/u,
  },
  {
    name: "anthropic relay emitter regresses to stream_observation presence (the JSON closeout regression)",
    path: "v3/crates/routecodex-v3-server/src/executors.rs",
    mutate: (source) =>
      source.replace(
        "                !client_body_is_sse,\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
        "                relay_output.stream_observation.is_none(),\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
      ),
    diagnostic:
      /anthropic relay console emitter must judge the client response body \(client_body\.is_sse\(\)\), not the stream observation/u,
  },
  {
    // File-scope blind spot: the responses relay lane lives in live_snapshot.rs,
    // so an anchor limited to the two executors would never see this regression.
    name: "responses relay emitter commits before the stream terminal (live_snapshot.rs)",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      source.replace(
        "            started_at,\n            output.stream_observation.is_none(),\n        );\n    }\n    let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_responses_relay(",
        "            started_at,\n            true,\n        );\n    }\n    let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_responses_relay(",
      ),
    diagnostic:
      /console emitter must pass the client response body stream judgment/u,
  },
  {
    // File-scope blind spot: the direct lane emitter lives in impl_bulk.rs.
    name: "direct lane emitter commits before the stream terminal (impl_bulk.rs)",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "        &observability,\n        started_at,\n        !is_sse,\n    );",
        "        &observability,\n        started_at,\n        true,\n    );",
      ),
    diagnostic:
      /console emitter must pass the client response body stream judgment/u,
  },
  {
    // The scan itself is the guard's weak point: an emit call written in a shape
    // the pattern cannot match (here a closing paren without a semicolon) leaves
    // an occurrence uncounted. The consistency assertion turns that silent gap
    // into an explicit failure instead of letting the emitter escape inspection.
    name: "emitter call shape escapes the scan (live_snapshot.rs)",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      `${source}\n#[allow(dead_code)]\nfn probe_unscannable_emit(\n    console_context: &V3ConsoleEmissionContext,\n    observability: &V3RuntimeObservability,\n    started_at: std::time::Instant,\n) {\n    emit_v3_observability_console_lines(\n        console_context,\n        200,\n        &[],\n        observability,\n        started_at,\n        observability.stream_observation.is_none()\n    )\n}\n`,
    diagnostic: /emitter scan may be incomplete/u,
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
