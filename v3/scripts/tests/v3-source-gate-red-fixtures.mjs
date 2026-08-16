#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = resolve(v3Root, 'scripts/architecture/verify-v3-module-boundaries.mjs');
const fixtures = [
  {
    name: 'provider transport outside provider owner',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_transport_owner() { let _ = reqwest::Client::new(); }\n',
    diagnostic: /provider transport outside provider crate/,
  },
  {
    name: 'server imports provider health store',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nuse routecodex_v3_provider_responses::V3ProviderHealthStore;\n',
    diagnostic: /Provider health store must remain opaque outside Provider and its Runtime boundary/,
  },
  {
    name: 'duplicate request node owner',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\npub struct V3Server03HttpRequestRaw;\n',
    diagnostic: /duplicate V3 Server03 request node/,
  },
  {
    name: 'server route shortcut',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_route_shortcut() { hit_opaque_target_plan_once(); }\n',
    diagnostic: /Server cannot select routes or interpret targets/,
  },
  {
    name: 'virtual router expands target internals',
    file: 'v3/crates/routecodex-v3-virtual-router/src/lib.rs',
    mutation: '\nfn forbidden_target_expansion(manifest: &V3Config05ManifestPublished) { let _ = &manifest.forwarders; }\n',
    diagnostic: /Virtual Router must return an opaque target and cannot interpret Target or Provider internals/,
  },
  {
    name: 'virtual router reads provider availability',
    file: 'v3/crates/routecodex-v3-virtual-router/src/lib.rs',
    transform: (source) => source.replace(
      '#[cfg(test)]',
      'use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;\n\n#[cfg(test)]',
    ),
    diagnostic: /Virtual Router cannot depend on Provider health or availability/,
  },
  {
    name: 'target re-enters virtual router',
    file: 'v3/crates/routecodex-v3-target/src/lib.rs',
    mutation: '\nfn forbidden_router_reentry(router: V3VirtualRouter, plan: routecodex_v3_virtual_router::V3Router06RoutePoolResolved) { let _ = router.hit_opaque_target_plan_once(plan, 0); }\n',
    diagnostic: /Target production source cannot re-enter Virtual Router/,
  },
  {
    name: 'target drops responses process',
    file: 'v3/crates/routecodex-v3-target/src/lib.rs',
    transform: (source) => source
      .replace('    pub responses_process: Option<String>,\n', '')
      .replace(/                responses_process: provider[\s\S]*?                responses_transport:/, '                responses_transport:'),
    diagnostic: /Target candidate must carry provider\.responses\.process/,
  },
  {
    name: 'execution decision ignores responses process chat',
    file: 'v3/crates/routecodex-v3-runtime/src/nodes.rs',
    transform: (source) => source.replace(/\.responses_process/g, '.provider_type'),
    diagnostic: /V3Execution11ProtocolDecision must route selected responses provider process=chat to HubRelay/,
  },
  {
    name: 'execution decision forces responses process chat to direct',
    file: 'v3/crates/routecodex-v3-runtime/src/nodes.rs',
    transform: (source) => source.replace(
      '        V3Execution11ProtocolDecisionMode::HubRelay\n    } else if entry_protocol == selected_provider_protocol {',
      '        V3Execution11ProtocolDecisionMode::SameProtocolDirect\n    } else if entry_protocol == selected_provider_protocol {',
    ),
    diagnostic: /V3Execution11ProtocolDecision must route selected responses provider process=chat to HubRelay/,
  },
  {
    name: 'runtime reconstructs control from client payload metadata',
    file: 'v3/crates/routecodex-v3-runtime/src/nodes.rs',
    mutation: '\nfn forbidden_payload_control(body: &serde_json::Value) { let _ = body.pointer("/metadata/runtime_control"); }\n',
    diagnostic: /cannot derive routing or MetadataCenter control from client payload metadata/,
  },
  {
    name: 'route classifier payload metadata carrier returns',
    file: 'v3/crates/routecodex-v3-runtime/src/nodes.rs',
    mutation: '\nstruct V3RouteClassifierMetadata;\n',
    diagnostic: /cannot derive routing or MetadataCenter control from client payload metadata/,
  },
  {
    name: 'server reconstructs continuation control from client payload metadata',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn extract_responses_client_scope(payload: &serde_json::Value) { let _ = payload.get("client_metadata"); }\n',
    diagnostic: /Server cannot rebuild continuation or admission control scope from client payload metadata/,
  },
  {
    name: 'server reconstructs provider health control from client payload metadata',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    transform: (source) => source.replace(
      '    V3ProviderFailureSessionScope::new(&server.id, &server.routing_group, &session_id)',
      '    let _ = serde_json::Value::Null.get("metadata");\n    V3ProviderFailureSessionScope::new(&server.id, &server.routing_group, &session_id)',
    ),
    diagnostic: /Server cannot rebuild provider-health control scope from client payload metadata/,
  },
  {
    name: 'req04 reconstructs chat from stored responses input',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs',
    mutation: '\nfn forbidden_req04_rebuild(restored: &serde_json::Value) { let _ = restored.get("input"); }\n',
    diagnostic: /Req04 cannot rebuild Chat semantics from a stored non-Chat continuation payload/,
  },
  {
    name: 'continuation response control enters chat payload',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
    mutation: '\nconst FORBIDDEN_CONTROL_PAYLOAD_KEY: &str = "continuation_response_id";\n',
    diagnostic: /continuation control identity cannot be embedded in Chat canonical payload/,
  },
  {
    name: 'provider identity special case',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\nfn forbidden_provider_case(provider_id: &str) -> bool { provider_id == "cc" }\n',
    diagnostic: /generic Responses Provider contains deployment provider identity branch/,
  },
  {
    name: 'obsolete provider prototype node',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\ntype ForbiddenOldProviderNode = V3Provider07ResponsesWirePayload;\n',
    diagnostic: /obsolete Provider prototype node name is forbidden/,
  },
  {
    name: 'provider imports target interpreter',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\nuse routecodex_v3_target::V3TargetInterpreter;\n',
    diagnostic: /generic Responses Provider cannot import or interpret Router\/Target\/Forwarder resources/,
  },
  {
    name: 'repair or fallback semantics',
    file: 'v3/crates/routecodex-v3-runtime/src/lib.rs',
    mutation: '\nfn forbidden_response_repair() {}\n',
    diagnostic: /forbidden V3 MVP lifecycle\/fallback wording/,
  },
  {
    name: 'undeclared Resp03 repair helper stays forbidden',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    mutation: '\nfn complete_or_repair_v3_resp03_history_frames() {}\n',
    diagnostic: /forbidden V3 MVP lifecycle\/fallback wording/,
  },
  {
    name: 'debug owns business topology',
    file: 'v3/crates/routecodex-v3-debug/src/lib.rs',
    mutation: '\nconst FORBIDDEN_DEBUG_TOPOLOGY: &str = "V3ResponsesDirect11Policy";\n',
    diagnostic: /Debug cannot own or hard-code the Responses Direct business lifecycle topology/,
  },
  {
    name: 'server bypasses Server16 builder',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn responses_direct_output_response_forbidden(_: V3Resp15ClientPayload) {}\n',
    diagnostic: /unique V3Resp15 -> V3Server16 builder/,
  },
  {
    name: 'dry run sends provider network',
    file: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs',
    transform: (source) => source.replace('"provider_network_send": false,', '"provider_network_send": true,'),
    diagnostic: /P6 Dry Run must execute the Provider pipeline and stop only the Provider network-send effect/,
  },
  {
    name: 'synthetic malformed JSON payload',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_synthetic_payload() { let _ = serde_json::json!({"raw_body_bytes": 1}); }\n',
    diagnostic: /cannot synthesize business payload/,
  },
  {
    name: 'broad business endpoint method handler',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_any_route() { let _ = Router::new().route("/v1/responses", any(pending_endpoint)); }\n',
    diagnostic: /broad any handler is forbidden/,
  },
  {
    name: 'listener task spawned before aggregate bind preflight',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    transform: (source) => source.replace(
      'bound.push((server, listener, bound_addr));',
      'tokio::spawn(async {});\n        bound.push((server, listener, bound_addr));',
    ),
    diagnostic: /bind the complete enabled listener set before spawning/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-source-red-'));
  try {
    cpSync(v3Root, join(root, 'v3'), {
      recursive: true,
      filter: (source) => !source.includes('/target/'),
    });
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    const testModule = source.indexOf('#[cfg(test)]');
    const mutated = fixture.transform
      ? fixture.transform(source)
      : testModule === -1
        ? source + fixture.mutation
        : source.slice(0, testModule) + fixture.mutation + source.slice(testModule);
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-source-gate-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-source-gate-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
