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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const verifiers = {
  admission: resolve(
    repo,
    "v3/scripts/architecture/verify-v3-responses-session-admission.mjs",
  ),
  client: resolve(
    repo,
    "v3/scripts/architecture/verify-v3-client-sse-head-commit.mjs",
  ),
};
const copied = [
  "package.json",
  "v3/package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/frame_builders.rs",
  "v3/crates/routecodex-v3-server/src/client_sse_transport.rs",
  "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
  "v3/crates/routecodex-v3-config/src/lib.rs",
  "v3/crates/routecodex-v3-config/src/types.rs",
  "v3/crates/routecodex-v3-config/tests/config_v3_contract.rs",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests/v3.responses_session_admission.mainline.yml",
  "docs/architecture/manifests/v3.client_sse_head_commit.mainline.yml",
  "docs/architecture/manifests/v3.sse.http_keepalive.mainline.yml",
  "docs/architecture/wiki/v3-responses-session-admission.md",
  "docs/architecture/wiki/v3-sse-http-keepalive.md",
];
const cases = [
  {
    name: "session business mutex is reintroduced",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      `${source}\nstruct V3ResponsesSessionAdmissionGate;\n`,
    diagnostic: /must not regain a session\/conversation or maintenance activity mutex/u,
  },
  {
    name: "request activity gate is reinserted before parsed dispatch",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "Box::pin(pending_endpoint_after_json_parse(",
        "request_activity_gate.admit().await;\n        Box::pin(pending_endpoint_after_json_parse(",
      ),
    diagnostic: /must not regain a session\/conversation or maintenance activity mutex/u,
  },
  {
    name: "body permit maintenance gate is reintroduced",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      `${source}\nfn hold_response_body_request_activity_permit() {}\n`,
    diagnostic: /must not regain a session\/conversation or maintenance activity mutex/u,
  },
  {
    name: "maintenance quiescence waiter is reintroduced",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      `${source}\nasync fn wait_for_quiescence() {}\n`,
    diagnostic: /must not regain a session\/conversation or maintenance activity mutex/u,
  },
  {
    name: "error SSE receives success keepalive",
    path: "v3/crates/routecodex-v3-server/src/frame_builders.rs",
    mutate: (source) =>
      source.replaceAll(
        "v3_client_sse_body(stream, None)",
        "v3_client_sse_body(stream, Some(Duration::from_millis(3_000)))",
      ),
    diagnostic: /Error06\/foundation SSE must bypass success keepalive injection/u,
  },
  {
    name: "CI omits canonical V3 verification",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll("        run: npm --prefix v3 run verify:ci\n", ""),
    diagnostic: /CI must dispatch the canonical V3 verification stack/u,
  },
  {
    name: "keepalive edge hides its typed config read",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replaceAll(
        "side_channel_reads: [v3.config.http_sse_keepalive_interval]",
        "side_channel_reads: []",
      ),
    diagnostic: /truthfully read the typed Config05 interval/u,
  },
  {
    name: "canonical keepalive config accepts the retired variable",
    path: "v3/crates/routecodex-v3-config/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "RCC_HTTP_SSE_KEEPALIVE_MS is not supported; use ROUTECODEX_HTTP_SSE_KEEPALIVE_MS",
        "RCC_HTTP_SSE_KEEPALIVE_MS is silently ignored",
      ),
    diagnostic: /reject the retired legacy keepalive variable/u,
  },
  {
    name: "session admission regains middleware parsing",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "async fn pending_endpoint(",
        "struct V3ResponsesAdmissionParsedPayload(Value);\nasync fn responses_session_admission_middleware() {}\n\nasync fn pending_endpoint(",
      ),
    diagnostic: /must not create middleware JSON parsing/u,
  },
  {
    name: "keepalive edge is reassigned to the SSE codec owner",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replaceAll(
        "owner_feature_id: v3.sse_http_keepalive_boundary",
        "owner_feature_id: v3.sse_transport_core_independent",
      ),
    diagnostic: /server-owned feature/u,
  },
  {
    name: "same-scope independent HTTP blackbox is removed",
    path: "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
    mutate: (source) =>
      source.replace(
        "async fn responses_same_listener_same_session_admits_independent_requests()",
        "async fn removed_same_scope_independence_blackbox()",
      ),
    diagnostic: /same-session independence blackbox must exist/u,
  },
  {
    name: "different-scope concurrency HTTP blackbox is removed",
    path: "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
    mutate: (source) =>
      source.replace(
        "async fn responses_same_listener_different_session_remains_concurrent()",
        "async fn removed_different_scope_concurrency_blackbox()",
      ),
    diagnostic: /different-scope concurrency blackbox must exist/u,
  },
  {
    name: "behavior gate omits the same-scope independent blackbox",
    path: "v3/package.json",
    mutate: (source) =>
      source.replace(
        " && node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server responses_same_listener_same_session_admits_independent_requests -- --exact --nocapture",
        "",
      ),
    diagnostic: /must execute the same-scope independence blackbox/u,
  },
  {
    name: "behavior gate omits the different-scope concurrency blackbox",
    path: "v3/package.json",
    mutate: (source) =>
      source.replace(
        " && node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server responses_same_listener_different_session_remains_concurrent -- --exact --nocapture",
        "",
      ),
    diagnostic: /must execute the different-scope concurrency blackbox/u,
  },
  {
    name: "behavior gate omits the client-drop HTTP blackbox",
    path: "v3/package.json",
    mutate: (source) =>
      source.replace(
        " && node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server responses_client_drop_releases_same_session_before_provider_eof -- --exact --nocapture",
        "",
      ),
    diagnostic: /must execute the controlled client-drop HTTP blackbox/u,
  },
  {
    name: "canonical wiki restores client-visible overlap rejection",
    path: "docs/architecture/wiki/v3-responses-session-admission.md",
    mutate: (source) =>
      source.replace(
        "Matching session, conversation or both never creates a business mutex",
        "returns HTTP 409 request_in_flight to the client",
      ),
    diagnostic: /must not retain the retired HTTP 409 overlap path/u,
  },
  {
    name: "Front closeout resource binding is removed from Client SSE",
    verifier: "client",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) => source.replace("  - v3.front.client_closeout_frame\n", ""),
    diagnostic: /must bind the Front closeout\/flush resource/u,
  },
  {
    name: "Front body EOF handoff restores the phantom activity caller",
    verifier: "client",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replace(
        "caller_symbol: V3FrontHttpIo::poll_flush",
        "caller_symbol: V3StableFrontSocket::hold_activity_until_flush",
      ),
    diagnostic: /body EOF handoff must use its real Front owner/u,
  },
  {
    name: "Front flush completion is detached from write_front_command",
    verifier: "client",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replace(
        "    callee_symbol: write_front_command\n    callee_file: v3/crates/routecodex-v3-server/src/restart_handoff.rs",
        "    callee_symbol: phantom_front_flush\n    callee_file: v3/crates/routecodex-v3-server/src/restart_handoff.rs",
      ),
    diagnostic: /Front flush completion must use its real Front owner/u,
  },
  {
    name: "Front closeout resource loses its declared owner",
    verifier: "client",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "  - resource_id: v3.front.client_closeout_frame\n    resource_kind: transport_control_resource\n    lifecycle: v3.runtime.restart_handoff_skeleton\n    owner_crate: routecodex-v3-server\n    owner_node: V3StableFrontSocket",
        "  - resource_id: v3.front.client_closeout_frame\n    resource_kind: transport_control_resource\n    lifecycle: v3.runtime.restart_handoff_skeleton\n    owner_crate: routecodex-v3-server\n    owner_node: V3RequestActivityGate",
      ),
    diagnostic: /Front closeout\/flush resource must retain its declared owner/u,
  },
  {
    name: "client manifest drops the Front closeout resource read",
    verifier: "client",
    path: "docs/architecture/manifests/v3.client_sse_head_commit.mainline.yml",
    mutate: (source) =>
      source.replace(
        "  - resource_id: v3.front.client_closeout_frame\n    owner_node: V3StableFrontSocket\n    consumer: write_front_command\n",
        "",
      ),
    diagnostic: /must read the real Front closeout\/flush resource/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-session-admission-red-"));
  try {
    for (const relative of copied) {
      cpSync(resolve(repo, relative), resolve(root, relative), {
        recursive: true,
      });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, "utf8");
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifiers[testCase.verifier ?? "admission"]], {
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
  console.error("[test:v3-responses-session-admission-red-fixtures] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-responses-session-admission-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
