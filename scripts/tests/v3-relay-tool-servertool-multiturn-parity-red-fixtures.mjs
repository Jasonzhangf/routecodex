#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs');
const copyPaths = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
  'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  'package.json',
];

const cases = [
  {
    name: 'orphan tool output fail-fast removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'OrphanToolOutput { index: usize, call_id: String }',
    mutation: 'MissingOrphanOutput { index: usize, call_id: String }',
    diagnostic: /OrphanToolOutput/,
  },
  {
    name: 'attachment history policy removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'pub enum V3HubAttachmentHistoryPolicy',
    mutation: 'pub enum V3HubAttachmentPolicyRemoved',
    diagnostic: /V3HubAttachmentHistoryPolicy/,
  },
  {
    name: 'attachment history governance moved before Req04',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: '        let mut events = vec![\n',
    mutation:
      '        govern_attachment_history_at_req04(&mut serde_json::Value::Null, &attachment_history_policy)?;\n        let mut events = vec![\n',
    diagnostic: /attachment history governance before Req04/,
  },
  {
    name: 'tool kind classifier removed',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    marker: 'pub(crate) fn classify_v3_hub_relay_tool_kind',
    mutation: 'pub(crate) fn classify_tool_kind_removed',
    diagnostic: /classify_v3_hub_relay_tool_kind/,
  },
  {
    name: 'protocol transport continuation matrix removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
    marker: 'protocol_transport_continuation_matrix_uses_one_chat_process_governance_path',
    mutation: 'protocol_transport_continuation_matrix_removed',
    diagnostic: /protocol_transport_continuation_matrix_uses_one_chat_process_governance_path/,
  },
  {
    name: 'focused parity test removed',
    file: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
    marker: 'request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id',
    mutation: 'request_governance_missing_negative_case',
    diagnostic: /request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id/,
  },
  {
    name: 'mainline edge owner drift',
    file: 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
    marker: 'owner_feature_id: v3.relay_tool_servertool_multiturn_parity_closeout',
    mutation: 'owner_feature_id: v3.hub_relay_runtime_closeout',
    diagnostic: /owner_feature_id mismatch|edge v3-relay-tool-parity/,
  },
  {
    name: 'package script removed',
    file: 'package.json',
    marker: '    "verify:v3-relay-tool-servertool-multiturn-parity-closeout": "node scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs",\n',
    mutation: '',
    diagnostic: /missing script verify:v3-relay-tool-servertool-multiturn-parity-closeout/,
  },
  {
    name: 'full materialization shortcut appears',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    marker: 'fn govern_tool_outputs_at_req04',
    mutation: 'fn full_materialize_govern_tool_outputs_at_req04',
    diagnostic: /fallback\/materialization|full_materialize/,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-relay-tool-parity-red-'));
  try {
    for (const relative of copyPaths) {
      const destination = resolve(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, relative), destination, { recursive: true });
    }
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.marker)) {
      failures.push(`${testCase.name}: mutation marker missing`);
      continue;
    }
    writeFileSync(target, source.replace(testCase.marker, testCase.mutation));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-900)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
