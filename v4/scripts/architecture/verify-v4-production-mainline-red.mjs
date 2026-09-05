#!/usr/bin/env node
/**
 * P0 red gate for the Cordis production-mainline migration.
 *
 * This gate must describe the current source, not a retired helper list.  It
 * intentionally reports RED while runtime-bin still owns protocol, routing,
 * retry, error, transport, or SSE business orchestration.  Once those calls
 * are removed, the same checks become the production GREEN gate.
 *
 * `--red-self-test` mutates an in-memory compliant fixture and proves every
 * forbidden class is rejected.  No repository file is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function productionOnly(source) {
  // Test-only helpers are interleaved with production declarations.  Use the
  // final test-module boundary; declarations above it are production code.
  const boundary = source.lastIndexOf('\n#[cfg(test)]');
  return boundary >= 0 ? source.slice(0, boundary) : source;
}

function runtimeProductionOnly(source) {
  return productionOnly(source);
}

function validateSources({
  runtimeBin,
  runtimeSource,
  runtimePipelineSource = runtimeSource,
  providerSource,
  responseInboundSource = '',
}) {
  const productionSource = productionOnly(runtimeBin);
  const runtimeOwnerSource = runtimeProductionOnly(runtimeSource);
  const pipelineSource = runtimeProductionOnly(runtimePipelineSource);
  const failures = [];

  if (/execute_request_scoped_with_owner\([\s\S]*?\)\s*\.map_err/.test(runtimeOwnerSource)
      && !/let\s+request_report\s*=/.test(runtimeOwnerSource)) {
    failures.push('REQUEST_REPORT_DISCARDED: request chain report is not consumed by production path');
  }

  // These are the current source symbols. Retired names must not make this
  // gate green while the real helpers remain in the production entry.
  const forbiddenDirectBusinessHelpers = [
    'handle_responses',
    'execute_retry_wire',
    'select_target_via_cordis',
    'dispatch_nonstream',
    'dispatch_streaming',
    'apply_product_error_policy',
    'project_provider_fault',
    'record_provider_failure',
    'CordisSseTransportStream',
    'route_group_for_request',
  ];
  for (const symbol of forbiddenDirectBusinessHelpers) {
    if (productionSource.includes(symbol)) {
      failures.push(`RUNTIME_BIN_DIRECT_BUSINESS_HELPER: ${symbol}`);
    }
  }

  // A facade in routecodex-v4-runtime is still a direct semantic pipeline.
  // Production execution must be driven by the admitted NodePluginPlan and
  // typed ports; these helpers are the old second orchestration surface.
  const forbiddenRuntimeBusinessHelpers = [
    'parse_request_admission_facts(',
    'fn handle_responses(',
    'fn execute_retry_wire(',
    'fn build_retry_wire(',
    'fn execute_provider_transport(',
    'fn send_provider_wire(',
    'fn project_fault(',
    'fn project_upstream_fault(',
    'fn project_provider_fault(',
    'fn record_provider_failure(',
    'struct CordisSseTransportStream',
    'SseIngressPlugin::new(',
    'SseEgressPlugin::new(',
    'apply_product_error_policy(',
  ];
  for (const symbol of forbiddenRuntimeBusinessHelpers) {
    if (runtimeOwnerSource.includes(symbol)) {
      failures.push(`RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER: ${symbol}`);
    }
  }

  if (!productionSource.includes('CordisAdmission::admit(')
      || !productionSource.includes('require_cordis_admission')) {
    failures.push('CORDIS_ADMISSION_WITNESS_MISSING: production startup must consume a real Cordis admission receipt');
  }
  if (productionSource.includes('cordis_service_readiness')) {
    failures.push('CORDIS_READINESS_MIRROR_IN_PRODUCTION: readiness mirror cannot satisfy admission');
  }

  if (!runtimeOwnerSource.includes('ProviderTransportPort::execute(')
      || !runtimeOwnerSource.includes('ProviderTransportRequest::new(')) {
    failures.push('PROVIDER_TRANSPORT_UNBOUND: runtime production pipeline must use a provider-owned typed transport port');
  }
  if (!runtimeOwnerSource.includes('execute_provider_response_scoped')) {
    failures.push('RESPONSE_CHAIN_UNBOUND: runtime production pipeline does not consume response chain output');
  }
  if (!/execute_provider_response_scoped[\s\S]*?report\.client_frame/.test(runtimeOwnerSource)) {
    failures.push('RESPONSE_JSON_FRAME_DISCARDED: JSON response chain output is not consumed');
  }
  if (!/request_report[\s\S]*?provider_wire_value/.test(runtimeOwnerSource)) {
    failures.push('REQUEST_WIRE_REPORT_DISCARDED: request report is not the provider-wire source');
  }
  // Target selection is a typed control decision produced by the Cordis
  // node. The request plan must consume that exact decision; invoking the
  // legacy target-aware helper lets the plan select a second provider.
  if (pipelineSource.includes('execute_request_json_scoped_for_target_with_lease(')
      || !pipelineSource.includes('execute_request_json_scoped_for_target_with_route_facts_and_lease(')
      || !/Some\(\s*route_facts(?:\.clone\(\))?\s*\)/.test(pipelineSource)
      || !/Some\(\s*target_selection(?:\.clone\(\))?\s*\)/.test(pipelineSource)) {
    failures.push('TARGET_SELECTION_NOT_PREBOUND: request plan must consume Cordis route_facts and target_selection');
  }
  if (!runtimeOwnerSource.includes('execute_error_plan_with_lease')
      || !runtimeOwnerSource.includes('project_http_fault_with_runtime')
      || !runtimeOwnerSource.includes('project_provider_http_fault_with_runtime')) {
    failures.push('ERROR_CHAIN_PRODUCTION_PLAN_UNBOUND: production HTTP/error paths must execute the admitted error NodePluginPlan');
  }

  if (runtimeOwnerSource.includes('decode_provider_sse_frame(')
      || runtimeOwnerSource.includes('encode_client_sse_frame(')) {
    failures.push('SSE_SEMANTIC_BYPASS: runtime directly invokes SSE semantic codec outside NodePluginPlan');
  }
  if (productionSource.includes('SseIngressPlugin::new(')
      || productionSource.includes('SseEgressPlugin::new(')
      || !runtimeOwnerSource.includes('production_transport_pair(')) {
    failures.push('SSE_TRANSPORT_CONSTRUCTION_BYPASS: runtime production pipeline must consume the opaque SSE transport pair from the transport owner');
  }

  const sendResponsesStart = providerSource.indexOf('pub fn send_responses(');
  const sendResponsesEnd = providerSource.indexOf('\npub fn send_responses_streaming(', sendResponsesStart);
  const sendResponsesSource = sendResponsesStart >= 0
    ? providerSource.slice(sendResponsesStart, sendResponsesEnd >= 0 ? sendResponsesEnd : undefined)
    : '';
  if (/normalize_provider_(?:response|sse_frame)/.test(sendResponsesSource)) {
    failures.push('PROVIDER_TRANSPORT_SEMANTIC_BYPASS: send_responses performs response/SSE normalization before RespInbound');
  }

  // Protocol projection belongs to the standard response NodePluginPlan. The
  // provider crate is transport/config/auth only; keeping normalizers there
  // creates a second semantic owner even when runtime reaches the plugin.
  if (/routecodex_v4_provider::normalize_provider_(?:response|sse_frame)/.test(responseInboundSource)) {
    failures.push('RESPONSE_PLUGIN_PROVIDER_SEMANTIC_BYPASS: response inbound plugin calls provider-owned normalizer');
  }
  if (/pub fn normalize_provider_(?:response|sse_frame)/.test(providerSource)) {
    failures.push('PROVIDER_SEMANTIC_OWNER_REMAINS: provider crate still exports response/SSE normalizer');
  }

  const sseStreamStart = runtimeOwnerSource.indexOf('struct CordisSseTransportStream');
  if (sseStreamStart >= 0
      && !/execute_provider_response_scoped[\s\S]*?report\.client_frame/.test(runtimeOwnerSource.slice(sseStreamStart))) {
    failures.push('RESPONSE_SSE_FRAME_DISCARDED: SSE response chain output is not consumed');
  }

  // The kernel-only target also forbids a second business orchestration
  // surface hidden behind an apparently generic handler name.
  if (/fn\s+(?:handle|process|route|dispatch)_?(?:request|response|stream)/.test(productionSource)) {
    failures.push('RUNTIME_BIN_BUSINESS_ORCHESTRATOR: production entry defines a request/response/stream orchestrator');
  }

  return failures;
}

function loadSources() {
  return {
    runtimeBin: fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime-bin/src/main.rs'), 'utf8'),
    runtimeSource: [
      runtimeProductionOnly(fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/lib.rs'), 'utf8')),
      runtimeProductionOnly(fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/production_pipeline.rs'), 'utf8')),
      runtimeProductionOnly(fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/production_sse.rs'), 'utf8')),
    ].join('\n'),
    runtimePipelineSource: fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/production_pipeline.rs'), 'utf8'),
    providerSource: fs.readFileSync(path.join(root, 'crates/routecodex-v4-provider/src/lib.rs'), 'utf8'),
    responseInboundSource: fs.readFileSync(path.join(root, 'crates/routecodex-v4-standard-plugins/src/response_inbound.rs'), 'utf8'),
  };
}

function runRedSelfTest() {
  const compliant = {
    runtimeBin: [
      'fn production_entry() {',
      '  CordisAdmission::admit();',
      '  require_cordis_admission();',
      '  production_pipeline::dispatch();',
      '}',
    ].join('\n'),
    runtimeSource: [
      'pub fn dispatch() {',
      '  let request_report = request_port.execute();',
      '  let provider_wire = request_report.provider_wire_value;',
      '  ProviderTransportRequest::new();',
      '  ProviderTransportPort::execute();',
      '  let report = execute_provider_response_scoped();',
      '  let frame = report.client_frame;',
      '  production_transport_pair();',
      '  execute_error_plan_with_lease();',
      '  project_http_fault_with_runtime();',
      '  project_provider_http_fault_with_runtime();',
      '}',
    ].join('\n'),
    runtimePipelineSource: [
      'let report = runtime.execute_request_json_scoped_for_target_with_route_facts_and_lease(',
      '  body, client_protocol, provider_protocol, model, stream, request_id, port, session, conversation,',
      '  Some("relay"), Some(route_facts), Some(target_selection), Some(&request_lease),',
      ');',
    ].join('\n'),
    providerSource: 'pub fn send_responses() {}\npub fn send_responses_streaming() {}',
    responseInboundSource: '',
  };
  const cases = [
    ['direct helper', 'fn handle_responses() {}', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['runtime owner helper', 'fn handle_responses() {}', 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'],
    ['request admission parser', 'fn parse_request_admission_facts() {}', 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'],
    ['retry helper', 'fn execute_retry_wire() {}', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['retry wire owner', 'fn build_retry_wire() {}', 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'],
    ['provider wire sender', 'fn send_provider_wire() {}', 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'],
    ['fault projection helper', 'fn project_fault() {}', 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'],
    ['routing helper', 'fn select_target_via_cordis() {}', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['provider dispatch', 'fn dispatch_streaming() {}', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['error policy', 'fn apply_product_error_policy() {}', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['sse stream', 'struct CordisSseTransportStream;', 'RUNTIME_BIN_DIRECT_BUSINESS_HELPER'],
    ['missing report consumption', 'let request_report = request_port.execute();', 'REQUEST_WIRE_REPORT_DISCARDED'],
    ['readiness mirror', 'fn cordis_service_readiness() {}', 'CORDIS_READINESS_MIRROR_IN_PRODUCTION'],
    ['sse semantic bypass', 'decode_provider_sse_frame();', 'SSE_SEMANTIC_BYPASS'],
    ['provider semantic bypass', 'pub fn send_responses() { normalize_provider_response(); }\npub fn send_responses_streaming() {}', 'PROVIDER_TRANSPORT_SEMANTIC_BYPASS'],
    ['response plugin provider bypass', 'routecodex_v4_provider::normalize_provider_response_for_relay();', 'RESPONSE_PLUGIN_PROVIDER_SEMANTIC_BYPASS'],
    ['provider exported normalizer', 'pub fn normalize_provider_response() {}', 'PROVIDER_SEMANTIC_OWNER_REMAINS'],
    ['error plan bypass', 'execute_error_plan_with_lease();', 'ERROR_CHAIN_PRODUCTION_PLAN_UNBOUND'],
    ['target selection bypass', 'execute_request_json_scoped_for_target_with_lease();', 'TARGET_SELECTION_NOT_PREBOUND'],
  ];
  let passed = 0;
  for (const [name, mutation, expected] of cases) {
    const runtimeBin = expected === 'CORDIS_READINESS_MIRROR_IN_PRODUCTION'
      ? `${compliant.runtimeBin}\n${mutation}`
      : expected === 'SSE_SEMANTIC_BYPASS'
        ? compliant.runtimeBin
        : expected === 'REQUEST_WIRE_REPORT_DISCARDED'
          ? compliant.runtimeBin
          : expected === 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'
            ? compliant.runtimeBin
          : `${compliant.runtimeBin}\n${mutation}`;
    const fixture = {
      ...compliant,
      runtimeBin,
      runtimeSource: expected === 'RUNTIME_PRODUCTION_DIRECT_BUSINESS_HELPER'
        ? `${compliant.runtimeSource}\n${mutation}`
        : expected === 'REQUEST_WIRE_REPORT_DISCARDED'
        ? compliant.runtimeSource.replace('  let provider_wire = request_report.provider_wire_value;\n', '')
        : expected === 'ERROR_CHAIN_PRODUCTION_PLAN_UNBOUND'
          ? compliant.runtimeSource
              .replace('  execute_error_plan_with_lease();\n', '')
              .replace('  project_http_fault_with_runtime();\n', '')
              .replace('  project_provider_http_fault_with_runtime();\n', '')
        : expected === 'SSE_SEMANTIC_BYPASS'
          ? `${compliant.runtimeSource}\n${mutation}`
          : compliant.runtimeSource,
      runtimePipelineSource: expected === 'TARGET_SELECTION_NOT_PREBOUND'
        ? compliant.runtimePipelineSource.replace(
            'execute_request_json_scoped_for_target_with_route_facts_and_lease',
            'execute_request_json_scoped_for_target_with_lease',
          )
        : compliant.runtimePipelineSource,
      providerSource: expected === 'PROVIDER_TRANSPORT_SEMANTIC_BYPASS'
        || expected === 'PROVIDER_SEMANTIC_OWNER_REMAINS' ? mutation : compliant.providerSource,
      responseInboundSource: expected === 'RESPONSE_PLUGIN_PROVIDER_SEMANTIC_BYPASS' ? mutation : compliant.responseInboundSource,
    };
    const failures = validateSources(fixture);
    if (!failures.some((failure) => failure.startsWith(expected))) {
      throw new Error(`red self-test failed: ${name} did not trigger ${expected}`);
    }
    passed += 1;
  }
  console.log(`[V4-PRODUCTION-MAINLINE-RED] red self-test ${passed}/${cases.length} PASS`);
}

if (process.argv.includes('--red-self-test')) {
  runRedSelfTest();
  process.exit(0);
}

const failures = validateSources(loadSources());
if (failures.length > 0) {
  console.error('[V4-PRODUCTION-MAINLINE-RED] EXPECTED RED');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('[V4-PRODUCTION-MAINLINE-RED] GREEN');
