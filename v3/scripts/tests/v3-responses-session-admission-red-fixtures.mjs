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
  "scripts/architecture/verify-v3-responses-session-admission.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/frame_builders.rs",
  "v3/crates/routecodex-v3-server/src/session_admission.rs",
  "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
  "v3/crates/routecodex-v3-config/src/lib.rs",
  "v3/crates/routecodex-v3-config/src/types.rs",
  "v3/crates/routecodex-v3-config/tests/config_v3_contract.rs",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests/v3.responses_session_admission.mainline.yml",
  "docs/architecture/manifests/v3.sse.http_keepalive.mainline.yml",
  "docs/architecture/wiki/v3-responses-session-admission.md",
  "docs/architecture/wiki/v3-sse-http-keepalive.md",
];
const cases = [
  {
    name: "conversation conflict is removed",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) =>
      source.replace(
        "                    || same_present_identity(&active.conversation_id, &scope.conversation_id))",
        ")",
      ),
    diagnostic: /Waiting contention must match either the explicit session or explicit conversation/u,
  },
  {
    name: "permit releases every active request",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) => source.replace(".remove(&token);", ".clear();"),
    diagnostic: /Permit drop must remove only its exact token and wake every predicate waiter/u,
  },
  {
    name: "server caller regains nonblocking admission",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        ".admit(V3ResponsesSessionAdmissionScope {",
        ".try_admit(V3ResponsesSessionAdmissionScope {",
      ),
    diagnostic: /caller must await the gate owner instead of projecting overlap|must not convert admission contention into request_in_flight/u,
  },
  {
    name: "permit release wakes only one unrelated waiter",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) =>
      source.replace("self.notify.notify_waiters();", "self.notify.notify_one();"),
    diagnostic: /wake every predicate waiter/u,
  },
  {
    name: "admission waiter is not registered before predicate check",
    path: "v3/crates/routecodex-v3-server/src/session_admission.rs",
    mutate: (source) =>
      source.replace("            notified.as_mut().enable();\n", ""),
    diagnostic: /lost-wakeup-safe notification ordering/u,
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
    name: "function map claims a fake inherent Drop symbol",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace(
        "<V3ResponsesSessionAdmissionPermit as Drop>::drop",
        "V3ResponsesSessionAdmissionPermit::drop",
      ),
    diagnostic: /real Drop trait implementation symbol|nonexistent inherent permit drop/u,
  },
  {
    name: "keepalive edge hides its typed config read",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replace(
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
    name: "same-scope wait-then-200 HTTP blackbox is removed",
    path: "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
    mutate: (source) =>
      source.replace(
        "async fn responses_same_listener_same_session_waits_for_release_then_returns_ok()",
        "async fn removed_same_scope_wait_then_ok_blackbox()",
      ),
    diagnostic: /wait-then-200 blackbox must exist/u,
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
    name: "behavior gate omits the same-scope wait-then-200 blackbox",
    path: "package.json",
    mutate: (source) =>
      source.replace(
        " && node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test multi_listener_server responses_same_listener_same_session_waits_for_release_then_returns_ok -- --exact --nocapture",
        "",
      ),
    diagnostic: /must execute the same-scope wait-then-200 blackbox/u,
  },
  {
    name: "behavior gate omits the different-scope concurrency blackbox",
    path: "package.json",
    mutate: (source) =>
      source.replace(
        " && node scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test multi_listener_server responses_same_listener_different_session_remains_concurrent -- --exact --nocapture",
        "",
      ),
    diagnostic: /must execute the different-scope concurrency blackbox/u,
  },
  {
    name: "behavior gate omits the client-drop HTTP blackbox",
    path: "package.json",
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
        "does not return an overlap error to the client",
        "returns HTTP 409 request_in_flight to the client",
      ),
    diagnostic: /must not retain the retired HTTP 409 overlap path/u,
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
  console.error("[test:v3-responses-session-admission-red-fixtures] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-responses-session-admission-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
