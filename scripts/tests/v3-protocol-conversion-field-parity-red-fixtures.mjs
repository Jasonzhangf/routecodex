#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-protocol-conversion-field-parity.mjs');
const files = [
  'docs/goals/v3-protocol-conversion-field-parity-test-design.md',
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs',
  'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'package.json',
];

const cases = [
  {
    name: 'Responses metadata dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "max_output_tokens",\n        "metadata",\n        "client_metadata",\n        "stop",',
    to: '        "max_output_tokens",\n        "client_metadata",\n        "stop",',
    diagnostic: /metadata/,
  },
  {
    name: 'Responses client_metadata dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "metadata",\n        "client_metadata",\n        "stop",',
    to: '        "metadata",\n        "stop",',
    diagnostic: /client_metadata/,
  },
  {
    name: 'Responses stop dropped before Chat provider wire',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: '        "client_metadata",\n        "stop",',
    to: '        "client_metadata",',
    diagnostic: /stop/,
  },
  {
    name: 'OpenAI Chat response model dropped before Responses projection',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    from: '    if let Some(model) = payload.get("model") {',
    to: '    if let Some(model) = payload.get("wire_model") {',
    diagnostic: /payload\.get\("model"\)/,
  },
  {
    name: 'OpenAI Chat created timestamp mapping dropped',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    from: 'payload.get("created_at").or_else(|| payload.get("created"))',
    to: 'payload.get("created_at")',
    diagnostic: /created/,
  },
  {
    name: 'Anthropic thinking data-plane state compressed away',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'json!({"effort":"medium","thinking":thinking})',
    to: 'json!({"effort":"medium"})',
    diagnostic: /thinking/,
  },
  {
    name: 'Responses reasoning request config no longer maps to Anthropic thinking',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
    from: 'responses_reasoning_request_config_as_anthropic_thinking(object)',
    to: 'object.get("reasoning").and_then(|reasoning| reasoning.get("thinking")).cloned()',
    diagnostic: /responses_reasoning_request_config_as_anthropic_thinking|thinking/,
  },
  {
    name: 'Anthropic provider compat drops original Responses reasoning surface',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
    from: 'build_v3_responses_original_input_surface_from_chat_canonical',
    to: 'build_v3_responses_original_input_surface_removed',
    all: true,
    diagnostic: /build_v3_responses_original_input_surface_from_chat_canonical|original_responses_payload|Anthropic/,
  },
  {
    name: 'Original Responses reasoning surface is array-input only again',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'original.get("input")?;',
    to: 'original.get("input").and_then(Value::as_array)?;',
    diagnostic: /responses_original_input_surface|original\.get\("input"\)|as_array/,
  },
  {
    name: 'Responses to Anthropic provider-wire reasoning runtime test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
    from: 'responses_relay_reasoning_request_config_reaches_anthropic_provider_as_thinking',
    to: 'responses_relay_reasoning_request_config_removed',
    all: true,
    diagnostic: /responses_relay_reasoning_request_config_reaches_anthropic_provider_as_thinking/,
  },
  {
    name: 'Responses string input to Anthropic provider-wire reasoning runtime test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
    from: 'responses_relay_string_input_reasoning_request_config_reaches_anthropic_provider_as_thinking',
    to: 'responses_relay_string_input_reasoning_request_config_removed',
    all: true,
    diagnostic: /responses_relay_string_input_reasoning_request_config_reaches_anthropic_provider_as_thinking/,
  },
  {
    name: 'Anthropic provider response reasoning runtime test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs',
    from: 'responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning',
    to: 'responses_relay_anthropic_provider_json_reasoning_removed',
    all: true,
    diagnostic: /responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning/,
  },
  {
    name: 'Responses request reasoning no longer maps to OpenAI Chat reasoning_effort',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: 'responses_reasoning_request_config_as_openai_chat_reasoning_effort',
    to: 'responses_reasoning_request_config_as_openai_chat_removed',
    all: true,
    diagnostic: /responses_reasoning_request_config_as_openai_chat_reasoning_effort|reasoning_effort/,
  },
  {
    name: 'OpenAI Chat provider-wire reasoning_effort runtime assertion removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    from: 'OpenAI Chat provider wire must project Responses reasoning to reasoning_effort',
    to: 'OpenAI Chat provider wire reasoning assertion removed',
    diagnostic: /reasoning_effort/,
  },
  {
    name: 'Malformed function arguments fail-fast parser removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs',
    from: 'parse_responses_function_call_arguments',
    to: 'parse_removed_arguments',
    all: true,
    diagnostic: /parse_responses_function_call_arguments/,
  },
  {
    name: 'OpenAI Chat same-protocol field matrix removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs',
    from: 'openai_chat_same_protocol_field_parity_request_response_matrix',
    to: 'same_protocol_matrix_removed',
    all: true,
    diagnostic: /openai_chat_same_protocol_field_parity_request_response_matrix/,
  },
  {
    name: 'Protocol parity incorrectly claims MetadataCenter owner',
    file: 'docs/architecture/v3-function-map.yml',
    from: '      - v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs\n      - v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    to: '      - v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs\n      - MetadataCenter\n      - v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
    diagnostic: /MetadataCenter|metadata_center/,
  },
  {
    name: 'Protocol parity source adds fallback branch',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
    from: 'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(\n    payload: &Value,\n) -> Result<Value, String> {',
    to: 'pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(\n    payload: &Value,\n) -> Result<Value, String> {\n    let _fallback_forbidden = false;',
    diagnostic: /fallback/i,
  },
  {
    name: 'Provider outbound strips all metadata by substring',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    from: 'fn is_provider_outbound_control_key(key: &str) -> bool {',
    to: 'fn is_provider_outbound_control_key(key: &str) -> bool {\n    if key.to_ascii_lowercase().contains("metadata") { return true; }',
    diagnostic: /contains\("metadata"\)|metadata/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-protocol-parity-red-'));
  try {
    for (const file of files) copyFileInto(root, file);
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.from)) throw new Error(`${testCase.name}: mutation source missing`);
    writeFileSync(
      target,
      testCase.all
        ? source.split(testCase.from).join(testCase.to)
        : source.replace(testCase.from, testCase.to),
    );
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-800)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-protocol-conversion-field-parity-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-protocol-conversion-field-parity-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);

function copyFileInto(root, file) {
  const source = resolve(repo, file);
  const target = resolve(root, file);
  if (!existsSync(source)) throw new Error(`missing source ${file}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}
