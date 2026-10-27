#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    // An emitter call whose parentheses never balance cannot be trusted; the
    // verifier must refuse instead of silently skipping it.
    name: "emitter call with unbalanced parentheses (live_snapshot.rs)",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      `${source}\n#[allow(dead_code)]\nfn probe_unscannable_emit(\n    console_context: &V3ConsoleEmissionContext,\n    observability: &V3RuntimeObservability,\n    started_at: std::time::Instant,\n) {\n    emit_v3_observability_console_lines(\n        console_context,\n        200,\n        &[],\n        observability,\n        started_at,\n        true\n    // missing closing paren\n}\n`,
    diagnostic: /could not be parsed \(unbalanced call parentheses\)/u,
  },
  {
    // The lane anchor must not depend on any nearby text: a comment claiming a
    // different lane's constructor must not hide the anthropic regression.
    name: "anthropic regression with a misleading neighbour comment",
    path: "v3/crates/routecodex-v3-server/src/executors.rs",
    mutate: (source) =>
      source.replace(
        "                !client_body_is_sse,\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
        "                relay_output.stream_observation.is_none(),\n            );\n        }\n        // same call shape as openai_chat_relay_output_response(\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
      ),
    diagnostic:
      /anthropic relay console emitter must judge the client response body \(client_body\.is_sse\(\)\), not the stream observation/u,
  },
  {
    // Renaming the anthropic response constructor must not hide the regression:
    // ownership is the in-scope client_body_is_sse binding, not the constructor.
    name: "anthropic regression with the response constructor renamed",
    paths: [
      "v3/crates/routecodex-v3-server/src/executors.rs",
      "v3/crates/routecodex-v3-server/src/endpoint_handlers.rs",
    ],
    mutate: (source) => {
      let mutated = source.replaceAll("anthropic_relay_output_response", "anthropic_output_response");
      mutated = mutated.replace(
        "                !client_body_is_sse,\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
        "                relay_output.stream_observation.is_none(),\n            );\n        }\n        let client_response_capture = V3LiveSnapFinalSseResponseCapture::from_anthropic_relay(",
      );
      return mutated;
    },
    diagnostic:
      /anthropic relay console emitter must judge the client response body \(client_body\.is_sse\(\)\), not the stream observation/u,
  },
  {
    // A single-line call followed by an allowlist-shaped tail must not be
    // over-scanned: paren balancing must report the real last argument `true`,
    // not a tail string from some later helper.
    name: "single-line emitter overshoots into a following helper",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      source.replace(
        "        emit_v3_observability_console_lines(\n            console_context,\n            output.status,\n            &output.node_trace,\n            observability,\n            started_at,\n            output.stream_observation.is_none(),\n        );",
        "        emit_v3_observability_console_lines(console_context, output.status, &output.node_trace, observability, started_at, true);\n        let _tail = format!(\"output.stream_observation.is_none()\");",
      ),
    diagnostic: /got "true"/u,
  },
  {
    // A comment that names the emitter is not an occurrence; the verifier must
    // not fail on it. This is a non-regression input, so it must PASS.
    name: "emitter name in a comment must not fail the scan",
    path: "v3/crates/routecodex-v3-server/src/live_snapshot.rs",
    mutate: (source) =>
      source.replace(
        "fn finalize_v3_responses_relay_server_output(",
        "// emit_v3_observability_console_lines( is the shared console emitter\nfn finalize_v3_responses_relay_server_output(",
      ),
    expectPass: true,
  },
  {
    // A brand new lane in a brand new file must be discovered and its include_usage
    // checked; living in another file must not let it escape the guard.
    name: "new lane in a new file escapes the scan (new_lane.rs)",
    create: {
      path: "v3/crates/routecodex-v3-server/src/new_lane.rs",
      content: `use std::time::Instant;

use crate::console::impl_bulk::emit_v3_observability_console_lines;
use crate::V3ConsoleEmissionContext;
use crate::V3RuntimeObservability;

pub(crate) fn probe_new_lane(
    console_context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    started_at: Instant,
) {
    emit_v3_observability_console_lines(
        console_context,
        200,
        &[],
        observability,
        started_at,
        true,
    );
}
`,
    },
    diagnostic: /new_lane\.rs console emitter must pass the client response body stream judgment/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-console-count-red-"));
  try {
    for (const relative of copied) {
      cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
    }
    // A case declares what it changes: one file via path+mutate, several files
    // via paths+mutate (for cross-file renames), or a brand new file via create.
    const edits = [];
    if (testCase.path !== undefined) {
      edits.push({ path: testCase.path, mutate: testCase.mutate });
    }
    for (const path of testCase.paths ?? []) {
      edits.push({ path, mutate: testCase.mutate });
    }
    if (testCase.create !== undefined) {
      edits.push({ path: testCase.create.path, replace: () => testCase.create.content });
    }
    let changed = 0;
    for (const edit of edits) {
      const target = resolve(root, edit.path);
      const original = existsSync(target) ? readFileSync(target, "utf8") : "";
      const mutated = edit.mutate !== undefined ? edit.mutate(original) : edit.replace(original);
      if (mutated !== original) changed += 1;
      writeFileSync(target, mutated);
    }
    if (changed === 0) {
      failures.push(`${testCase.name}: mutation did not change any target file`);
      continue;
    }
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (testCase.expectPass === true) {
      // A non-regression case: the guard must not fail on this input.
      if (result.status !== 0) {
        failures.push(`${testCase.name}: verifier unexpectedly failed: ${output.slice(-1200)}`);
      }
      continue;
    }
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

const rejected = cases.filter((testCase) => testCase.expectPass !== true).length;
const accepted = cases.length - rejected;
console.log(
  `[test:v3-console-request-count-visibility-red-fixtures] PASS (${rejected} forbidden mutations rejected, ${accepted} non-regression inputs accepted)`,
);
