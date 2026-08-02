#!/usr/bin/env node

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-provider-session-cooldown.mjs",
);
const copied = [
  "v3/crates/routecodex-v3-error/src/lib.rs",
  "v3/crates/routecodex-v3-provider-responses/src/health.rs",
  "v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs",
  "v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs",
  "v3/crates/routecodex-v3-runtime/src/nodes.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/tests/mod.rs",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "v3/crates/routecodex-v3-server/tests/multi_listener_server.rs",
  "package.json",
];

const cases = [

  {
    name: "Validated HTTP input drops typed session control-header reader",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        ", build_v3_provider_failure_session_scope_for_request",
        "",
      ),
    diagnostic: /Validated HTTP input must allow only the Server scope builder/u,
  },

  {
    name: "Resource map removes typed failure session scope resource",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "resource_id: v3.provider.failure_session_scope",
        "resource_id: v3.provider.failure_session_scope_removed",
      ),
    diagnostic: /missing v3\.provider\.failure_session_scope resource/u,
  },
  {
    name: "Resource map lets Provider Health write failure session scope",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "allowed_writers: [V3ProviderFailureSessionScope::new]",
        "allowed_writers: [V3ProviderHealthStore::record_provider_failure_in_session]",
      ),
    diagnostic: /failure session scope writer must be only|failure session scope must not be written/u,
  },
  {
    name: "Mainline v3-de-18 falsely points scope builder at Provider Health mutation",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replace(
        "to_node: V3ProviderFailureSessionScope",
        "to_node: V3ProviderHealthStateMutated",
      ),
    diagnostic: /v3-de-18 must produce the typed provider failure session scope node|v3-de-18 must not claim Provider Health/u,
  },
  {
    name: "Mainline v3-de-18 falsely produces provider health state",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replaceAll(
        "v3.provider.failure_session_scope",
        "v3.provider.health_state",
      ),
    diagnostic: /v3-de-18 must produce provider failure session scope|v3-de-18 must not claim Provider Health/u,
  },
  {
    name: "Resource map reverts health identity to provider-global",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "identity: [serverId, routingGroup, sessionId, providerRuntimeIdentity]",
        "identity: [providerId, authAlias, modelId, reason, untilMs]",
      ),
    diagnostic: /Resource map must bind provider health state identity/u,
  },
  {
    name: "Resource map grants Runtime wrapper provider health write ownership",
    path: "docs/architecture/v3-resource-operation-map.yml",
    mutate: (source) =>
      source.replace(
        "allowed_writers: [V3ProviderHealthStore::record_provider_failure_in_session, V3ProviderHealthStore::record_provider_success_in_session, V3ProviderHealthStore::try_acquire_cross_session_revive]",
        "allowed_writers: [V3ProviderFailureRuntimeHealth::record_provider_failure_record, V3ProviderHealthStore::record_provider_failure_in_session, V3ProviderHealthStore::record_provider_success_in_session]",
      ),
    diagnostic: /Resource map provider health writers must name only session-scoped|Resource map must not register Runtime wrappers/u,
  },
  {
    name: "Function map retains removed provider-global health symbol",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace(
        "V3ProviderHealthStore::record_provider_failure_in_session",
        "V3ProviderHealthStore::record_provider_failure",
      ),
    diagnostic: /Function map must list current session-scoped|Function map must not retain removed/u,
  },
  {
    name: "Mainline map points direct failure edge to removed provider-global API",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      source.replaceAll(
        "callee_symbol: V3ProviderHealthStore::record_provider_failure_in_session",
        "callee_symbol: V3ProviderHealthStore::record_provider_failure",
      ),
    diagnostic: /Mainline map v3-de-14 must bind|Mainline map must not point/u,
  },
  {
    name: "Error05 witness drops session scope",
    path: copied[0],
    mutate: (source) =>
      source.replace(
        "    failure_session_scope: V3ProviderFailureSessionScope,",
        "    failure_session_scope_removed: V3ProviderFailureSessionScope,",
      ),
    diagnostic: /Error05 recovery witness must carry/u,
  },
  {
    name: "Error05 constructor restores legacy non-session arguments",
    path: copied[0],
    mutate: (source) =>
      source.replace(
        "        failure_session_scope: V3ProviderFailureSessionScope,",
        "        server_id: impl Into<String>,",
      ),
    diagnostic: /Error05 witness constructor must require/u,
  },
  {
    name: "Health session key drops routing group",
    path: copied[1],
    mutate: (source) =>
      source.replace(
        "struct V3ProviderFailureSessionKey {\n    server_id: String,\n    routing_group: String,",
        "struct V3ProviderFailureSessionKey {\n    server_id: String,\n    routing_group_removed: String,",
      ),
    diagnostic: /Provider Health must key failure-derived state/u,
  },
  {
    name: "Health drops atomic revive owner",
    path: copied[1],
    mutate: (source) =>
      source.replaceAll("try_acquire_cross_session_revive", "revive_without_atomic_owner"),
    diagnostic: /Provider Health must own atomic cross-session revive admission/u,
  },
  {
    name: "ActionGate key drops session",
    path: copied[2],
    mutate: (source) =>
      source.replace(
        "pub struct V3ProviderActionGateKey {\n    pub provider_scope: V3ProviderActionProviderScope,\n    pub session_id: String,",
        "pub struct V3ProviderActionGateKey {\n    pub provider_scope: V3ProviderActionProviderScope,\n    pub session_id_removed: String,",
      ),
    diagnostic: /Provider ActionGate key must include session_id/u,
  },
  {
    name: "ActionGate constructor drops typed session",
    path: copied[2],
    mutate: (source) =>
      source.replace(
        "        failure_session_scope: &V3ProviderFailureSessionScope,",
        "        server_id: impl Into<String>,",
      ),
    diagnostic: /Provider ActionGate provider scope constructor must require/u,
  },
  {
    name: "Direct raw request drops typed scope",
    path: copied[4],
    mutate: (source) =>
      source.replace(
        "    pub failure_session_scope: V3ProviderFailureSessionScope,",
        "    pub failure_session_scope_removed: V3ProviderFailureSessionScope,",
      ),
    diagnostic: /Direct raw request must carry/u,
  },
  {
    name: "Responses Relay drops typed scope",
    path: copied[8],
    mutate: (source) =>
      source.replace(
        "    pub failure_session_scope: V3ProviderFailureSessionScope,",
        "    pub failure_session_scope_removed: V3ProviderFailureSessionScope,",
      ),
    diagnostic: /Responses Relay must carry/u,
  },
  {
    name: "Server stops constructing validated scope",
    path: copied[12],
    mutate: (source) =>
      source.replaceAll("V3ProviderFailureSessionScope::new(", "legacy_session_scope("),
    diagnostic: /Server\/ReqInbound must construct/u,
  },
  {
    name: "Server drops typed RouteCodex session-header behavior test",
    path: copied[13],
    mutate: (source) =>
      source.replace(
        "fn provider_failure_scope_uses_existing_session_header()",
        "fn provider_failure_scope_uses_generic_client_header()",
      ),
    diagnostic: /Server must lock the existing request session header/u,
  },
  {
    name: "Server drops missing typed session-header rejection test",
    path: copied[13],
    mutate: (source) =>
      source.replace(
        "fn provider_failure_scope_rejects_missing_existing_session_header()",
        "fn provider_failure_scope_accepts_missing_existing_session_header()",
      ),
    diagnostic: /Server must fail closed when the existing request session header is missing/u,
  },
  {
    name: "Server drops missing-session no-send blackbox",
    path: copied[18],
    mutate: (source) =>
      source.replace(
        "async fn responses_direct_missing_failure_session_fails_before_any_provider_send()",
        "async fn responses_direct_missing_failure_session_can_send_provider()",
      ),
    diagnostic: /Server blackbox must prove missing existing session fails before provider send/u,
  },
  {
    name: "Session cooldown gate restores broad provider integration binary execution",
    path: copied[19],
    mutate: (source) =>
      source.replace(
        "-p routecodex-v3-provider-responses --lib health::tests",
        "-p routecodex-v3-provider-responses health::tests",
      ),
    diagnostic: /Provider session cooldown gate must avoid unrelated integration binaries/u,
  },
  {
    name: "Runtime drops session-bound availability",
    path: copied[3],
    mutate: (source) =>
      source.replaceAll("session_bound_availability", "global_availability"),
    diagnostic: /Runtime policy must construct session-bound availability/u,
  },
  {
    name: "Server restores request-id failure-scope fallback",
    path: copied[12],
    mutate: (source) =>
      source.replace(
        "provider_failure_session_id_from_request_headers(headers)?.ok_or_else(|| {",
        "provider_failure_session_id_from_request_headers(headers)?\n            .or_else(|| Some(request_id.to_string()))\n            .ok_or_else(|| {",
      ),
    diagnostic: /must not derive control identity from request identity/u,
  },
  {
    name: "Direct SSE drops original typed session scope",
    path: copied[7],
    mutate: (source) =>
      source.replace(
        "    pub(super) failure_session_scope: V3ProviderFailureSessionScope,",
        "    pub(super) failure_session_scope_removed: V3ProviderFailureSessionScope,",
      ),
    diagnostic: /Direct SSE post-commit outcome must retain/u,
  },
  {
    name: "Direct failure policy drops atomic revive owner",
    path: copied[6],
    mutate: (source) =>
      source.replace(
        "try_acquire_cross_session_revive",
        "revive_without_atomic_health_owner",
      ),
    diagnostic: /Direct provider failure policy must consume/u,
  },
];

let rejected = 0;
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-provider-session-cooldown-"));
  try {
    for (const relativePath of copied) {
      const destination = join(root, relativePath);
      cpSync(join(repo, relativePath), destination, { recursive: true });
    }
    const target = join(root, testCase.path);
    const original = readFileSync(target, "utf8");
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      throw new Error(`${testCase.name}: mutation did not change source`);
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      env: { ...process.env, V3_PROVIDER_SESSION_COOLDOWN_ROOT: root },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !testCase.diagnostic.test(output)) {
      throw new Error(
        `${testCase.name}: verifier did not reject mutation with expected diagnostic\n${output}`,
      );
    }
    rejected += 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`V3 provider session cooldown red fixtures passed (${rejected}/${cases.length}).`);
