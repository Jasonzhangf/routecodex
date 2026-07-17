#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-module-boundaries.mjs');
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
    mutation: '\nuse routecodex_v3_provider_responses::V3ProviderAvailabilityReader;\n',
    diagnostic: /Virtual Router cannot depend on Provider health or availability/,
  },
  {
    name: 'target re-enters virtual router',
    file: 'v3/crates/routecodex-v3-target/src/lib.rs',
    mutation: '\nfn forbidden_router_reentry(router: V3VirtualRouter, plan: routecodex_v3_virtual_router::V3Router06RoutePoolResolved) { let _ = router.hit_opaque_target_plan_once(plan, 0); }\n',
    diagnostic: /Target production source cannot re-enter Virtual Router/,
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
    file: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
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
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), {
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
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
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
