#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { verifyV3StageProtocolShapes } from '../architecture/verify-v3-stage-protocol-shapes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const files = {
  manifest: 'docs/architecture/manifests/v3.stage_protocol_shape_contract.yml',
  mainline: 'docs/architecture/v3-mainline-call-map.yml',
};
const inputs = Object.fromEntries(Object.entries(files).map(([name, relative]) =>
  [name, YAML.parse(fs.readFileSync(path.join(root, relative), 'utf8'))]));
const mutations = [
  ['direct-protocol-conversion', (d) => { d.manifest.chains[2].stages[1].exit_shape = 'canonical_chat_request'; }, /Direct stage|must be V3Provider12ResponsesWirePayload/],
  ['relay-source-wire-crosses-chat', (d) => { d.manifest.chains[0].stages[2].entry_shape = 'source_request_wire'; }, /must be V3HubReqChatProcess04Governed|shape discontinuity/],
  ['relay-outbound-leaves-chat-extension', (d) => { d.manifest.chains[0].stages[6].exit_shape = 'canonical_chat_request'; }, /must be ProviderReqCompat06ProviderCompat/],
  ['mainline-adjacent-edge-drift', (d) => {
    const chain = d.mainline.chains.find((row) => row.chain_id === 'v3.hub_pipeline.v1.request');
    chain.edges.find((edge) => edge.step_id === 'v3-hub-req-06').to_node = 'V3ProviderReqOutbound08WirePayload';
  }, /v3-hub-req-06 must be anchored V3HubReqOutbound07ProviderSemantic -> ProviderReqCompat06ProviderCompat/],
  ['missing-control-field-boundary', (d) => { delete d.manifest.rules.control_fields; }, /control fields/i],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-stage-shape-data-'));
function write(doc) {
  for (const [name, relative] of Object.entries(files)) {
    const target = path.join(tmp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, YAML.stringify(doc[name]));
  }
}
try {
  write(inputs);
  assert.deepEqual(verifyV3StageProtocolShapes(tmp), [], 'baseline must be GREEN');
  for (const [name, mutate, expected] of mutations) {
    const doc = structuredClone(inputs);
    mutate(doc);
    write(doc);
    const failures = verifyV3StageProtocolShapes(tmp);
    assert.ok(failures.length > 0, `${name}: unexpectedly GREEN`);
    assert.match(failures.join('\n'), expected, name);
  }
  console.log(`[v3-stage-protocol-shapes-red] GREEN baseline + ${mutations.length} data mutations rejected`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
