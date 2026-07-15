#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const failures = [];

function files(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files(path, out);
    else if (path.endsWith('.rs') || path.endsWith('Cargo.toml')) out.push(path);
  }
  return out;
}

function fail(message) {
  failures.push(message);
}

const serverCargo = readFileSync('v3/crates/routecodex-v3-server/Cargo.toml', 'utf8');
const serverProdDeps = serverCargo.split('[dev-dependencies]')[0];
if (serverProdDeps.includes('routecodex-v3-provider-responses')) {
  fail('server production Cargo dependencies import provider crate');
}

const cliCargo = readFileSync('v3/crates/routecodex-v3-cli/Cargo.toml', 'utf8');
if (cliCargo.includes('routecodex-v3-provider-responses')) {
  fail('CLI Cargo dependencies import provider crate');
}

for (const path of files('v3/crates/routecodex-v3-server/src')) {
  const text = readFileSync(path, 'utf8');
  if (text.includes('routecodex_v3_provider_responses')) {
    fail('server source imports provider crate: ' + path);
  }
}

for (const path of files('v3/crates/routecodex-v3-cli/src')) {
  const text = readFileSync(path, 'utf8');
  if (text.includes('routecodex_v3_provider_responses')) {
    fail('CLI source imports provider crate: ' + path);
  }
}

const repoRoot = process.cwd();
for (const fixture of [
  ['server', 'routecodex-v3-server', 'v3/crates/routecodex-v3-server'],
  ['cli', 'routecodex-v3-cli', 'v3/crates/routecodex-v3-cli'],
]) {
  const [name, dependencyName, dependencyPath] = fixture;
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-${name}-shortcut-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\n${dependencyName} = { path = "${resolve(repoRoot, dependencyPath)}" }\n`,
    );
    writeFileSync(
      join(sourceDir, 'main.rs'),
      'use routecodex_v3_provider_responses::ReqwestResponsesTransport;\nfn main() { let _ = ReqwestResponsesTransport::default(); }\n',
    );
    const result = spawnSync(
      'cargo',
      ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')],
      {
        encoding: 'utf8',
        env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
      },
    );
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) {
      fail(`${name} compile-fail fixture unexpectedly imported provider transport`);
    } else if (!/unresolved import|unlinked crate|undeclared crate or module/.test(diagnostic)) {
      fail(`${name} compile-fail fixture failed for wrong reason: ${diagnostic.slice(-600)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-health-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-target-health-mutation-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-provider-responses = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-provider-responses')}" }\n`,
    );
    writeFileSync(
      join(sourceDir, 'main.rs'),
      'use routecodex_v3_provider_responses::V3ProviderHealthStore;\nfn main() { let store = V3ProviderHealthStore::default(); let _ = store.apply_error_action(todo!(), 0); }\n',
    );
    const result = spawnSync(
      'cargo',
      ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')],
      {
        encoding: 'utf8',
        env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
      },
    );
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) {
      fail('Target compile-fail fixture unexpectedly imported Provider health mutation store');
    } else if (!/method `apply_error_action` is private|private method/.test(diagnostic)) {
      fail(`Target health compile-fail fixture failed for wrong reason: ${diagnostic.slice(-600)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-router-availability-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-router-availability-shortcut-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-virtual-router = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-virtual-router')}" }\n`,
    );
    writeFileSync(
      join(sourceDir, 'main.rs'),
      'use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;\nfn main() {}\n',
    );
    const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) fail('Virtual Router compile-fail fixture unexpectedly imported Provider availability');
    else if (!/unresolved import|unlinked crate|undeclared crate or module/.test(diagnostic)) fail(`Router availability compile-fail fixture failed for wrong reason: ${diagnostic.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-router-one-shot-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-router-one-shot-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-config = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-config')}" }\nroutecodex-v3-virtual-router = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-virtual-router')}" }\n`,
    );
    writeFileSync(
      join(sourceDir, 'main.rs'),
      'use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};\nuse routecodex_v3_virtual_router::V3VirtualRouter;\nfn main() { let source = r#"version = 3\n[servers.s]\nbind = "127.0.0.1"\nport = 1\nrouting_group = "g"\n[providers.p]\ntype = "responses"\nbase_url = "http://p.invalid/v1"\ndefault_model = "m"\nauth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }\n[providers.p.models.m]\n[route_groups.g.pools.default]\ntargets = [{ kind = "provider_model", provider = "p", model = "m", key = "k" }]\n"#; let manifest = compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap(); let router = V3VirtualRouter::default(); let classified = router.classify_request(&manifest, "s", "/v1/responses").unwrap(); let plan = router.resolve_route_pool_plan(&manifest, classified).unwrap(); let _ = router.hit_opaque_target_plan_once(plan, 0); let _ = router.hit_opaque_target_plan_once(plan, 0); }\n',
    );
    const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) fail('Virtual Router one-shot fixture unexpectedly reused a consumed pool token');
    else if (!/use of moved value: `plan`|value used here after move/.test(diagnostic)) fail(`Router one-shot compile-fail fixture failed for wrong reason: ${diagnostic.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-router-private-plan-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-router-private-plan-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-virtual-router = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-virtual-router')}" }\n`,
    );
    writeFileSync(
      join(sourceDir, 'main.rs'),
      'use routecodex_v3_virtual_router::V3Router06RoutePoolResolved;\nfn main() { let _ = V3Router06RoutePoolResolved { server_id: String::new(), routing_group_id: String::new(), tiers: Vec::new() }; }\n',
    );
    const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) fail('Virtual Router private plan fixture unexpectedly constructed the one-shot plan');
    else if (!/private field|private fields|E0451/.test(diagnostic)) fail(`Router private plan fixture failed for wrong reason: ${diagnostic.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fixture of [
  {
    name: 'wire node private constructor',
    code: 'use routecodex_v3_provider_responses::V3Provider12ResponsesWirePayload;\nfn main() { let _ = V3Provider12ResponsesWirePayload { request_id: String::new(), target: todo!(), stream_intent: todo!(), body: todo!() }; }\n',
  },
  {
    name: 'transport request private constructor',
    code: 'use routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest;\nfn main() { let _ = V3Transport13ResponsesHttpRequest { request_id: String::new(), provider_id: String::new(), url: todo!(), auth: todo!(), stream_intent: todo!(), body: todo!(), cancellation: None }; }\n',
  },
  {
    name: 'provider raw private constructor',
    code: 'use routecodex_v3_provider_responses::V3ProviderResp14Raw;\nfn main() { let _ = V3ProviderResp14Raw { request_id: String::new(), provider_id: String::new(), status: 200, headers: Vec::new(), body: todo!() }; }\n',
  },
]) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-provider-node-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-provider-private-node-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-provider-responses = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-provider-responses')}" }\n`,
    );
    writeFileSync(join(sourceDir, 'main.rs'), fixture.code);
    const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) fail(`${fixture.name} unexpectedly constructed a provider node outside its owner`);
    else if (!/private field|private fields|E0451/.test(diagnostic)) fail(`${fixture.name} failed for wrong reason: ${diagnostic.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fixture of [
  {
    name: 'Hub node private constructor',
    code: 'use routecodex_v3_runtime::{build_v3_hub_req_inbound_01_client_raw, V3HubEntryProtocol, V3HubInvocationSource, V3HubReqInbound02Normalized, V3HubTransportIntent};\nfn main() { let previous = build_v3_hub_req_inbound_01_client_raw(serde_json::json!({}), V3HubEntryProtocol::Responses, V3HubInvocationSource::Client, V3HubTransportIntent::Json); let _ = V3HubReqInbound02Normalized { previous }; }\n',
    diagnostic: /private field|E0451/,
  },
  {
    name: 'Hub Req04 private constructor',
    code: 'use routecodex_v3_runtime::{build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02, build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, V3HubContinuationOwnership, V3HubEntryProtocol, V3HubInvocationSource, V3HubReqChatProcess04Governed, V3HubTransportIntent};\nfn main() { let req01 = build_v3_hub_req_inbound_01_client_raw(serde_json::json!({}), V3HubEntryProtocol::Responses, V3HubInvocationSource::Client, V3HubTransportIntent::Json); let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01); let previous = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(req02, V3HubContinuationOwnership::New); let _ = V3HubReqChatProcess04Governed { previous }; }\n',
    diagnostic: /private field|E0451/,
  },
  {
    name: 'Hub non-adjacent conversion',
    code: 'use routecodex_v3_runtime::{build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_target_06_from_v3_hub_req_execution_05, V3HubEntryProtocol, V3HubInvocationSource, V3HubTargetResolution, V3HubTransportIntent};\nfn main() { let req01 = build_v3_hub_req_inbound_01_client_raw(serde_json::json!({}), V3HubEntryProtocol::Responses, V3HubInvocationSource::Client, V3HubTransportIntent::Json); let _ = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(req01, V3HubTargetResolution::Routed); }\n',
    diagnostic: /mismatched types|expected `V3HubReqExecution05Planned`/,
  },
  {
    name: 'Hub Req04 bypass into execution plan',
    code: 'use routecodex_v3_runtime::{build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02, build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04, V3HubContinuationOwnership, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubTransportIntent};\nfn main() { let req01 = build_v3_hub_req_inbound_01_client_raw(serde_json::json!({}), V3HubEntryProtocol::Responses, V3HubInvocationSource::Client, V3HubTransportIntent::Json); let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01); let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(req02, V3HubContinuationOwnership::New); let _ = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(req03, V3HubExecutionMode::Relay); }\n',
    diagnostic: /mismatched types|expected `V3HubReqChatProcess04Governed`/,
  },
  {
    name: 'Hub independent Relay request lifecycle constructor',
    code: 'use routecodex_v3_runtime::V3HubRelayRequestHooks;\nfn main() { let _ = V3HubRelayRequestHooks { _sealed: () }; }\n',
    diagnostic: /private field|E0451/,
  },
]) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-node-compile-fail-'));
  const sourceDir = join(root, 'src');
  try {
    mkdirSync(sourceDir);
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname = "v3-hub-node-compile-fail-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nroutecodex-v3-runtime = { path = "${resolve(repoRoot, 'v3/crates/routecodex-v3-runtime')}" }\nserde_json = "1"\n`,
    );
    writeFileSync(join(sourceDir, 'main.rs'), fixture.code);
    const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', join(root, 'Cargo.toml')], {
      encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) fail(`${fixture.name} unexpectedly compiled`);
    else if (!fixture.diagnostic.test(diagnostic)) fail(`${fixture.name} failed for wrong reason: ${diagnostic.slice(-800)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-compile-fail] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[test:v3-compile-fail] ok');
