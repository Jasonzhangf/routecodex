#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];

function files(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (path.includes('/target/') || path.endsWith('/target')) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
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
  const semanticProductionText = productionText
    .replace(/\.method_not_allowed_fallback\(method_not_allowed\)/g, '')
    .replace(/\.fallback\(path_not_found\)/g, '');
  const isTest = path.includes('/tests/');
  const isErrorOwner = path.includes('routecodex-v3-error/src/');
  const isProviderOwner = path.includes('routecodex-v3-provider-responses/src/');
  const isProviderHealthRuntimeBoundary =
    path.endsWith('routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs');
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
  const httpListenerText = text.replace(/std::net::TcpListener::bind/g, '');
  if (!path.includes('routecodex-v3-server') && /axum::serve|TcpListener::bind/.test(httpListenerText) && !isTest) {
    fail('HTTP listener outside server crate: ' + path);
  }
  if (!isTest && !path.includes('routecodex-v3-config') && !isProviderOwner
      && /fs::read_to_string|std::fs::read_to_string|std::fs::read\(/.test(productionText)) {
    fail('config authoring file IO outside config crate: ' + path);
  }
  if (!path.includes('routecodex-v3-runtime') && /pub async fn execute_v3_responses_direct_runtime_kernel/.test(text)) {
    fail('full lifecycle executor outside runtime crate: ' + path);
  }
  if (!isTest && /run_.*pipeline|dynamic.*hook|discover.*hook|fallback|sanitize|repair|raw replay|forced relay/i.test(semanticProductionText)) {
    fail('forbidden V3 MVP lifecycle/fallback wording in source: ' + path);
  }
  if (!isTest && !isErrorOwner && /pub struct V3Error0[1-6]/.test(text)) {
    fail('duplicate V3 Error node writer outside global Error owner: ' + path);
  }
  if (!isTest && !path.includes('routecodex-v3-runtime/src/') && /pub struct V3Server03HttpRequestRaw/.test(text)) {
    fail('duplicate V3 Server03 request node outside Runtime contract owner: ' + path);
  }
  if (!isTest && !isProviderOwner
      && /\.apply_error_action\(|\.update_quota_state\(|\.update_concurrency_state\(/.test(text)) {
    fail('Provider health mutation surface outside Provider owner: ' + path);
  }
  if (!isTest && !isProviderOwner && !isProviderHealthRuntimeBoundary
      && /V3ProviderHealthStore/.test(text)) {
    fail('Provider health store must remain opaque outside Provider and its Runtime boundary: ' + path);
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

const serverSource = files('v3/crates/routecodex-v3-server/src')
  .map((path) => read(path).replace(/#\[cfg\(test\)\][\s\S]*/, ''))
  .join('\n');
if (/build_v3_error_0[1-6]|V3ErrorSourceKind|V3ErrorActionScope/.test(serverSource)) {
  fail('Server must project Runtime output and cannot build or classify Error nodes');
}
if (/route_groups|resolve_default_pool|resolve_selection_plan|hit_opaque_target_once|hit_opaque_target_plan_once|expand_candidates|select_available/.test(serverSource)) {
  fail('Server cannot select routes or interpret targets');
}
if (!/build_v3_server_16_http_frame_from_v3_resp_15/.test(serverSource)
    || /fn\s+\w*responses_direct_output_response\w*\([^)]*V3Resp15ClientPayload/.test(serverSource)) {
  fail('Server success response must enter the unique V3Resp15 -> V3Server16 builder before HTTP emission');
}
if (/unwrap_or\("application\/json"\)/.test(serverSource)) {
  fail('Server cannot default a missing V3Resp15 content-type during Server16 framing');
}
if (/route\(\s*"\/v1\/(?:responses|messages|chat\/completions)"\s*,\s*any\(/.test(serverSource)) {
  fail('business endpoints require explicit method dispatch; broad any handler is forbidden');
}
if (/raw_body_bytes|body_read_error|unwrap_or_else\([^)]*serde_json::from_slice/.test(serverSource)) {
  fail('Server cannot synthesize business payload from malformed JSON or body read failure');
}
if (!/read_json_payload[\s\S]*Result<serde_json::Value,[\s\S]*V3Error06ClientProjected/.test(serverSource)
    || !/V3HttpBoundaryErrorKind::MalformedJson/.test(serverSource)
    || !/V3HttpBoundaryErrorKind::BodyTooLarge/.test(serverSource)) {
  fail('Server HTTP body boundary must fail through typed Error projection before Runtime');
}
if (!/\.method_not_allowed_fallback\(method_not_allowed\)/.test(serverSource)
    || !/\.fallback\(path_not_found\)/.test(serverSource)) {
  fail('Server must explicitly project unsupported method and path errors');
}
const bindPush = serverSource.indexOf('bound.push((server, listener, bound_addr))');
const listenerSpawn = serverSource.indexOf('tokio::spawn');
if (bindPush === -1 || listenerSpawn === -1 || listenerSpawn < bindPush) {
  fail('Server must bind the complete enabled listener set before spawning any listener task');
}

const configTypes = read('v3/crates/routecodex-v3-config/src/types.rs');
if (/pub provider_type: String[\s\S]{0,80}serde\(default/.test(configTypes)) {
  fail('provider wire protocol cannot have an implicit Config default');
}

const debugSource = files('v3/crates/routecodex-v3-debug/src').map(read).join('\n');
if (/V3Server03HttpRequestRaw|V3ResponsesDirect11Policy|V3Provider12ResponsesWirePayload|V3Resp15ClientPayload|V3Server16HttpFrame/.test(debugSource)) {
  fail('Debug cannot own or hard-code the Responses Direct business lifecycle topology');
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
if (/classify_request|resolve_default_pool|resolve_selection_plan|hit_opaque_target_once|hit_opaque_target_plan_once|V3VirtualRouter::/.test(targetSource.replace(/#\[cfg\(test\)\][\s\S]*/, ''))) {
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
if (/execute_v3_foundation_dry_run_runtime/.test(foundationSource)) {
  fail('dead foundation Dry Run lifecycle must not coexist with the Runtime-owned P6 Dry Run');
}

const runtimeKernelSource = read('v3/crates/routecodex-v3-runtime/src/kernel.rs');
const dryRunSource = runtimeKernelSource.match(/pub async fn execute_v3_responses_direct_dry_run_runtime[\s\S]*?\n}\n\npub async fn execute_v3_responses_direct_runtime_kernel/)?.[0] ?? '';
if (!/V3DryRunNoNetworkTransport/.test(dryRunSource)
    || !/"provider_pipeline_executed": true/.test(dryRunSource)
    || !/"provider_network_send": false/.test(dryRunSource)
    || !/"stopped_before_provider_send": true/.test(dryRunSource)
    || /"provider_network_send": true/.test(dryRunSource)
    || !/execute_v3_responses_direct_runtime_kernel_with_transport_and_debug/.test(dryRunSource)
    || !/V3Transport13ResponsesHttpRequest/.test(dryRunSource)
    || !/V3DryRunNoNetworkTerminalEffect/.test(dryRunSource)) {
  fail('P6 Dry Run must execute the Provider pipeline and stop only the Provider network-send effect');
}

if (failures.length) {
  console.error('[verify:v3-module-boundaries] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-module-boundaries] ok');
