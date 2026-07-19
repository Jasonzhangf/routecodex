#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const hub = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs'), 'utf8');
const tests = readFileSync(
  resolve(root, 'v3/crates/routecodex-v3-runtime/tests/hub_anthropic_relay_protocol_hooks.rs'),
  'utf8',
);
const failures = [];

function fail(message) {
  failures.push(message);
}

function requireAll(text, owner, phrases) {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbidAll(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) fail(`${owner}: forbidden ${pattern}`);
  }
}

function rustFiles(relative) {
  const absolute = resolve(root, relative);
  const files = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) files.push(...rustFiles(join(relative, entry)));
    else if (entry.endsWith('.rs')) files.push(path);
  }
  return files;
}

requireAll(source, sourcePath, [
  'compile_v3_anthropic_relay_protocol_hooks',
  'req_inbound: run_v3_anthropic_relay_req_inbound_hook',
  'client_projection: run_v3_anthropic_relay_client_projection_hook',
  'V3HubReqInbound01ClientRaw',
  'V3HubReqInbound02Normalized',
  'V3HubRespContinuation04Committed',
  'V3HubRespOutbound05ClientSemantic',
  'build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01',
  'build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  'encode_v3_anthropic_request_as_responses_semantic',
  'validate_v3_anthropic_hub_response_payload_for_client_projection',
  'entry_protocol != V3HubEntryProtocol::Anthropic',
  'execution != V3HubExecutionMode::Relay',
  'provider_wire_protocol != V3HubProviderWireProtocol::Responses',
  'EntryProtocolNotAnthropic',
  'ExecutionModeNotRelay',
  'ProviderWireProtocolNotResponses',
]);
forbidAll(source, sourcePath, [
  /characterize_v3_anthropic_hub_semantic_to_provider_wire/,
  /characterize_v3_anthropic_provider_raw_to_hub_response_semantic/,
  /V3AnthropicRelayReqInboundNormalized|V3AnthropicRelayClientProjection/,
  /V3HubProviderWireProtocol::Anthropic/,
  /V3ProviderReqOutbound09TransportRequest/,
  /V3ServerRespOutbound06ClientFrame/,
  /routecodex_v3_server|routecodex_v3_provider_responses|reqwest|axum/,
  /provider[_-]?family|model[_-]?prefix/i,
  /dynamic[_-]?hook|discover[_-]?hook/i,
  /fallback/i,
  /serde_json::(?:to_string|to_vec|from_str|from_slice)/,
  /\.payload\.clone\s*\(|\.0\.clone\s*\(/,
]);

requireAll(hub, 'fixed Hub v1 module registry', [
  'mod anthropic_relay_hooks;',
  'pub use anthropic_relay_hooks::*;',
]);
requireAll(tests, 'focused Anthropic Relay hook tests', [
  'anthropic_entry_req_inbound_hook_encodes_to_responses_chat_semantic_before_req04',
  'anthropic_client_projection_hook_preserves_responses_wire_axis',
  'wrong_entry_execution_and_provider_wire_combinations_fail_explicitly',
  'side_channel_fields_fail_at_both_protocol_hook_boundaries',
  'V3HubEntryProtocol::Anthropic',
  'V3HubExecutionMode::Relay',
  'V3HubProviderWireProtocol::Responses',
  'V3HubProviderWireProtocol::Anthropic',
  'metadata_center',
  'debug_snapshot',
  'provider_protocol',
  'resource_handle',
]);

for (const path of [
  ...rustFiles('v3/crates/routecodex-v3-server/src'),
  ...rustFiles('v3/crates/routecodex-v3-provider-responses/src'),
]) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (/compile_v3_anthropic_relay_protocol_hooks|V3AnthropicRelayProtocolHooks/.test(text)) {
    fail(`${path}: Anthropic Relay hook slice cannot be wired into Server or Provider transport`);
  }
}

if (failures.length) {
  console.error('[verify:v3-anthropic-relay-protocol-hooks] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-anthropic-relay-protocol-hooks] ok');
