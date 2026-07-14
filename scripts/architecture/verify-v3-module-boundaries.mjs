#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const all = files('v3');
const read = (path) => readFileSync(path, 'utf8');

for (const path of all) {
  const text = read(path);
  const productionText = text.replace(/#\[cfg\(test\)\][\s\S]*/, '');
  const isTest = path.includes('/tests/');
  const isErrorOwner = path.includes('routecodex-v3-error/src/');
  const isProviderOwner = path.includes('routecodex-v3-provider-responses/src/');
  const isProviderTransportSurface = path.endsWith('routecodex-v3-provider-responses/src/transport.rs')
    || path.endsWith('routecodex-v3-provider-responses/src/shared.rs');
  if (/V3Provider07ResponsesWirePayload|V3Transport08ResponsesHttpRequest|V3ProviderResp09Raw|V3Resp10ClientPayload|build_v3_provider_07|build_v3_transport_08|V3Provider07|V3Transport08|V3ProviderResp09/.test(text)) {
    fail('obsolete Provider prototype node name is forbidden in V3 source: ' + path);
  }
  if (!isTest && !path.includes('routecodex-v3-provider-responses') && /reqwest::Client|\.send\(\)/.test(text)) {
    fail('provider transport outside provider crate: ' + path);
  }
  if (!isTest && isProviderOwner && !isProviderTransportSurface && /\breqwest::/.test(productionText)) {
    fail('Reqwest usage in generic Responses Provider is restricted to transport/shared surfaces: ' + path);
  }
  if (!isTest && isProviderOwner
      && /routecodex_v3_virtual_router|routecodex_v3_target|V3VirtualRouter|V3TargetInterpreter|route_groups|forwarders/i.test(productionText)) {
    fail('generic Responses Provider cannot import or interpret Router/Target/Forwarder resources: ' + path);
  }
  if (!isTest && isProviderOwner
      && /(?:api_key|secret|token|bearer)[a-z_]*\s*:\s*String/i.test(productionText)
      && !/V3ProviderAuthSecretHandle|Environment\(String\)|TokenFile\(String\)/.test(productionText)) {
    fail('wire/raw/error Provider DTOs must not store resolved secret values: ' + path);
  }
  if (!path.includes('routecodex-v3-server') && /axum::serve|TcpListener::bind/.test(text) && !isTest) {
    fail('HTTP listener outside server crate: ' + path);
  }
  if (!isTest && !path.includes('routecodex-v3-config') && !isProviderOwner
      && /fs::read_to_string|std::fs::read_to_string|std::fs::read\(/.test(text)) {
    fail('config authoring file IO outside config crate: ' + path);
  }
  if (!path.includes('routecodex-v3-runtime') && /pub async fn execute_v3_responses_direct_runtime_kernel/.test(text)) {
    fail('full lifecycle executor outside runtime crate: ' + path);
  }
  if (!isTest && /run_.*pipeline|dynamic.*hook|discover.*hook|fallback|sanitize|repair|raw replay|forced relay/i.test(productionText)) {
    fail('forbidden V3 MVP lifecycle/fallback wording in source: ' + path);
  }
  if (!isTest && !isErrorOwner && /pub struct V3Error0[1-6]/.test(text)) {
    fail('duplicate V3 Error node writer outside global Error owner: ' + path);
  }
  if (!isTest && !path.includes('routecodex-v3-runtime/src/') && /pub struct V3Server03HttpRequestRaw/.test(text)) {
    fail('duplicate V3 Server03 request node outside Runtime contract owner: ' + path);
  }
  if (!isTest && !isProviderOwner && /V3ProviderHealthStore|\.apply_error_action\(|\.update_quota_state\(|\.update_concurrency_state\(/.test(text)) {
    fail('Provider health mutation surface outside Provider owner: ' + path);
  }
  if (!isTest && isProviderOwner
      && (/\b(?:cc|asxs)\b/.test(productionText)
        || /provider_(?:id|family)\s*(?:==|!=)\s*"/i.test(productionText)
        || /match\s+provider_(?:id|family)\b/i.test(productionText))) {
    fail('generic Responses Provider contains deployment provider identity branch: ' + path);
  }
}

const serverCargo = read('v3/crates/routecodex-v3-server/Cargo.toml');
if (/routecodex-v3-provider-responses/.test(serverCargo.replace(/\[dev-dependencies\][\s\S]*/, ''))) {
  fail('server crate production dependencies must not include provider crate');
}

const cliCargo = read('v3/crates/routecodex-v3-cli/Cargo.toml');
if (/routecodex-v3-provider-responses/.test(cliCargo)) {
  fail('CLI must not depend on provider transport directly');
}

const hookSource = read('v3/crates/routecodex-v3-runtime/src/hooks.rs');
if (/serde_json::from_slice|default_tier|providers\.get/.test(hookSource)) {
  fail('hook module contains shared route/response logic instead of orchestration');
}

const serverSource = files('v3/crates/routecodex-v3-server/src').map(read).join('\n');
if (/build_v3_error_0[1-6]|V3ErrorSourceKind|V3ErrorActionScope/.test(serverSource)) {
  fail('Server must project Runtime output and cannot build or classify Error nodes');
}
if (/route_groups|resolve_default_pool|hit_opaque_target_once|expand_candidates|select_available/.test(serverSource)) {
  fail('Server cannot select routes or interpret targets');
}

const errorSource = files('v3/crates/routecodex-v3-error/src').map(read).join('\n');
if (/V3ProviderHealthStore|apply_error_action|update_quota_state|update_concurrency_state/.test(errorSource)) {
  fail('Error owner must generate action plans and cannot mutate Provider health');
}

for (const crateName of ['routecodex-v3-virtual-router', 'routecodex-v3-target']) {
  const crateRoot = `v3/crates/${crateName}`;
  if (!all.some((path) => path.startsWith(crateRoot + '/'))) continue;
  const source = files(crateRoot).map(read).join('\n');
  if (/V3ProviderHealthStore|apply_error_action|update_quota_state|update_concurrency_state/.test(source)) {
    fail(`${crateName} cannot import Provider health mutation APIs`);
  }
  if (crateName.endsWith('-virtual-router') && /routecodex-v3-provider-responses|V3ProviderAvailabilityReader|V3ProviderAvailabilityProjection|V3ProviderHealth/.test(source)) {
    fail('Virtual Router cannot depend on Provider health or availability');
  }
}

const routerSource = files('v3/crates/routecodex-v3-virtual-router/src').map(read).join('\n');
const routerProductionSource = routerSource.replace(/#\[cfg\(test\)\][\s\S]*/, '');
if (/forwarders|providers|base_url|auth_alias|wire_model|Reqwest|Transport/.test(routerProductionSource)) {
  fail('Virtual Router must return an opaque target and cannot interpret Target or Provider internals');
}

const targetSource = files('v3/crates/routecodex-v3-target/src').map(read).join('\n');
if (/classify_request|resolve_default_pool|hit_opaque_target_once|V3VirtualRouter::/.test(targetSource.replace(/#\[cfg\(test\)\][\s\S]*/, ''))) {
  fail('Target production source cannot re-enter Virtual Router');
}

const foundationSource = read('v3/crates/routecodex-v3-runtime/src/foundation.rs');
if (!/build_v3_req_04_standardized_responses_from_v3_server_03/.test(foundationSource)) {
  fail('P5 Runtime must traverse Server03 -> Req04 before Virtual Router');
}
if (/execute_v3_p5_routing_runtime[\s\S]*run_provider_transport|execute_v3_p5_routing_runtime[\s\S]*\.send\(/.test(foundationSource)) {
  fail('P5 runtime terminal path cannot send a Provider request');
}
if (/ResponsesTransport|execute_v3_responses_direct_runtime_kernel|\.send\(/.test(foundationSource)) {
  fail('P3 Dry Run foundation cannot call Responses Provider transport or P6 Runtime kernel');
}

if (failures.length) {
  console.error('[verify:v3-module-boundaries] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-module-boundaries] ok');
