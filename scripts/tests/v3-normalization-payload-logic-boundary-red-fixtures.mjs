#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-normalization-payload-logic-boundary.mjs');
const fixtures = [
  {
    name: 'OpenAI Chat request normalize tool identity pairing',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs',
    from: 'fn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {\n    reject_side_channel_fields(payload)?;',
    to: 'fn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {\n    let _tool_call_id = "tool_call_id";\n    reject_side_channel_fields(payload)?;',
    diagnostic: /OpenAI Chat request shape validation/,
  },
  {
    name: 'OpenAI Chat response normalize tool identity pairing',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs',
    from: 'fn validate_json_response(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {\n    if payload.get("error").is_some()',
    to: 'fn validate_json_response(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {\n    let _tool_call_id = "tool_call_id";\n    if payload.get("error").is_some()',
    diagnostic: /OpenAI Chat JSON response shape validation/,
  },
  {
    name: 'Gemini request normalize functionCall functionResponse pairing',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs',
    from: 'fn validate_content_shapes(contents: &[Value]) -> Result<(), V3GeminiCodecError> {',
    to: 'fn validate_content_shapes(contents: &[Value]) -> Result<(), V3GeminiCodecError> {\n    let _function_response = "functionResponse";',
    diagnostic: /Gemini content shape validation/,
  },
  {
    name: 'ProviderReqCompat06 tool governance',
    file: 'docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml',
    from: 'node_id: ProviderReqCompat06ProviderCompat\n    phase: request',
    to: 'node_id: ProviderReqCompat06ProviderCompat\n    tool_governance: allowed\n    phase: request',
    diagnostic: /ProviderReqCompat06ProviderCompat manifest node/,
  },
  {
    name: 'ProviderRespCompat02 tool governance',
    file: 'docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml',
    from: 'node_id: ProviderRespCompat02ProviderCompat\n    phase: response',
    to: 'node_id: ProviderRespCompat02ProviderCompat\n    tool_governance: allowed\n    phase: response',
    diagnostic: /ProviderRespCompat02ProviderCompat manifest node/,
  },
  {
    name: 'Anthropic protocol mapping is allowed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
    from: 'pub fn encode_v3_anthropic_request_as_responses_semantic(',
    to: '// protocol mapping may mention messages/tools without tool identity governance\npub fn encode_v3_anthropic_request_as_responses_semantic(',
    expectPass: true,
    diagnostic: /must pass/,
  },
  {
    name: 'ReqInbound tool governance',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'V3HubReqInbound02Normalized {\n        previous: input,',
    to: 'let _tool_calls = "tool_calls";\n    V3HubReqInbound02Normalized {\n        previous: input,',
    diagnostic: /ReqInbound02 entry normalization/,
  },
  {
    name: 'RespInbound servertool hook',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'let normalized_kind = match input.raw().transport_intent {',
    to: 'let _servertool_hook = "servertool hook";\n    let normalized_kind = match input.raw().transport_intent {',
    diagnostic: /RespInbound02 entry normalization/,
  },
  {
    name: 'ReqOutbound payload schema logic',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'V3HubReqOutbound07ProviderSemantic {\n        previous: input,',
    to: 'let _schema = "schema";\n    V3HubReqOutbound07ProviderSemantic {\n        previous: input,',
    diagnostic: /ReqOutbound07 provider semantic projection/,
  },
  {
    name: 'Provider wire apply_patch logic',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'V3ProviderReqOutbound08WirePayload { previous: input }',
    to: 'let _apply_patch = "apply_patch";\n    V3ProviderReqOutbound08WirePayload { previous: input }',
    diagnostic: /ProviderReqOutbound08 wire boundary/,
  },
  {
    name: 'RespOutbound required_action inference',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'V3HubRespOutbound05ClientSemantic { previous: input }',
    to: 'let _required_action = "required_action";\n    V3HubRespOutbound05ClientSemantic { previous: input }',
    diagnostic: /RespOutbound05 client semantic projection/,
  },
  {
    name: 'Server frame stopless logic',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'V3ServerRespOutbound06ClientFrame { previous: input }',
    to: 'let _stopless = "stopless";\n    V3ServerRespOutbound06ClientFrame { previous: input }',
    diagnostic: /ServerRespOutbound06 frame projection/,
  },
  {
    name: 'Relay normalize hook logic',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    from: 'fn normalize_v3_hub_relay_response(\n    input: V3ProviderRespInbound01Raw,\n) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {',
    to: 'fn normalize_v3_hub_relay_response(\n    input: V3ProviderRespInbound01Raw,\n) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {\n    let _hook = "hook";',
    diagnostic: /Relay response normalize wrapper/,
  },
  {
    name: 'servertool before context restore',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'let local_context = restore_local_context_at_req04(ownership, lookup)?;\n        if local_context.is_some()',
    to: 'run_servertool_profile(profile, &mut events)?;\n        let local_context = restore_local_context_at_req04(ownership, lookup)?;\n        if local_context.is_some()',
    diagnostic: /servertool hook must run after context restore/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-normalization-red-'));
  try {
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-runtime/src'), join(root, 'v3/crates/routecodex-v3-runtime/src'), { recursive: true });
    cpSync(resolve(repoRoot, 'docs/architecture/manifests'), join(root, 'docs/architecture/manifests'), { recursive: true });
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.from)) throw new Error(`${fixture.name}: fixture source missing`);
    writeFileSync(target, source.replace(fixture.from, fixture.to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (fixture.expectPass) {
      if (result.status !== 0) failures.push(`${fixture.name}: gate unexpectedly failed: ${output.slice(-600)}`);
    } else if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-normalization-payload-logic-boundary-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
const rejectedCount = fixtures.filter((fixture) => !fixture.expectPass).length;
const allowedCount = fixtures.length - rejectedCount;
console.log(`[test:v3-normalization-payload-logic-boundary-red-fixtures] ok (${rejectedCount} forbidden mutations rejected, ${allowedCount} allowed protocol mapping fixture passed)`);
