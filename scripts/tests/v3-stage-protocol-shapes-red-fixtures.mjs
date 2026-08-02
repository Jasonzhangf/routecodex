#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { verifyV3StageProtocolShapes } from '../architecture/verify-v3-stage-protocol-shapes.mjs';

const root = process.cwd();
const mutations = [
  { name: 'direct-protocol-conversion', mutateManifest: (doc) => { doc.chains[2].stages[1].exit_shape = 'canonical_chat_request'; }, expected: /Direct stage|must be V3Provider12ResponsesWirePayload/ },
  { name: 'relay-source-wire-crosses-chat', mutateManifest: (doc) => { doc.chains[0].stages[2].entry_shape = 'source_request_wire'; }, expected: /must be V3HubReqContinuation03Classified|shape discontinuity/ },
  { name: 'relay-outbound-leaves-chat-extension', mutateManifest: (doc) => { doc.chains[0].stages[7].exit_shape = 'canonical_chat_request'; }, expected: /must be ProviderReqCompat06ProviderCompat/ },
  { name: 'missing-stage-validator-owner', mutateManifest: (doc) => { doc.chains[1].stages[2].validator_owner = 'missing_owner_symbol'; }, expected: /validator owner is not a real Rust function in validator_source/ },
  { name: 'wrong-stage-validator-source', mutateManifest: (doc) => { doc.chains[1].stages[2].validator_source = 'v3/crates/routecodex-v3-runtime/src/hooks.rs'; }, expected: /validator owner is not a real Rust function in validator_source/ },
  {
    name: 'rust-validator-input-type-drift',
    mutateSource: (tmp) => {
      const sourcePath = path.join(tmp, 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs');
      const source = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(sourcePath, source.replace('input: V3HubReqTarget06Resolved,', 'input: V3HubReqExecution05Planned,'));
    },
    expected: /V3HubReqOutbound07ProviderSemantic validator input types must be V3HubReqTarget06Resolved, V3HubProviderWireProtocol/,
  },
  {
    name: 'rust-validator-output-type-drift',
    mutateSource: (tmp) => {
      const sourcePath = path.join(tmp, 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs');
      const source = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(sourcePath, source.replace(') -> V3ProviderReqOutbound08WirePayload {', ') -> ProviderReqCompat06ProviderCompat {'));
    },
    expected: /V3ProviderReqOutbound08WirePayload validator output type must be V3ProviderReqOutbound08WirePayload/,
  },
  {
    name: 'rust-validator-wrong-impl-owner',
    mutateManifest: (doc) => { doc.chains[2].stages[3].validator_impl = 'V3ProviderResponseBody'; },
    expected: /V3ProviderResp14Raw validator must belong to impl V3ProviderResponseBody/,
  },
  {
    name: 'mainline-adjacent-edge-drift',
    mutateMainline: (doc) => {
      const chain = doc.chains.find((candidate) => candidate.chain_id === 'v3.hub_pipeline.v1.request');
      chain.edges.find((edge) => edge.step_id === 'v3-hub-req-07').to_node = 'V3ProviderReqOutbound08WirePayload';
    },
    expected: /v3-hub-req-07 must be anchored V3HubReqOutbound07ProviderSemantic -> ProviderReqCompat06ProviderCompat/,
  },
  { name: 'missing-control-field-lock', mutateManifest: (doc) => { delete doc.rules.control_fields; }, expected: /control fields/i },
  {
    name: 'direct-helper-relay-codec-call',
    mutateSource: (tmp) => {
      const helperPath = path.join(tmp, 'v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs');
      const source = fs.readFileSync(helperPath, 'utf8');
      fs.writeFileSync(helperPath, `${source}\n// build_v3_openai_chat_standard_request_from_chat_canonical\n`);
    },
    expected: /Direct runtime must not invoke relay codec build_v3_openai_chat_standard_request_from_chat_canonical/,
  },
  {
    name: 'direct-relay-handoff-drops-request-local-exclusions',
    mutateSource: (tmp) => {
      const helperPath = path.join(tmp, 'v3/crates/routecodex-v3-runtime/src/kernel.rs');
      const source = fs.readFileSync(helperPath, 'utf8');
      fs.writeFileSync(helperPath, source.replace(
        'captured_target_09,\n                failed_candidates.clone(),\n                trace,',
        'captured_target_09,\n                BTreeSet::new(),\n                trace,',
      ));
    },
    expected: /Direct-to-Relay handoff must preserve request-local exclusions/,
  },
];

let failed = 0;
for (const mutation of mutations) {
  const { name, expected } = mutation;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `v3-stage-shape-${name}-`));
  try {
    for (const relative of [
      'docs/architecture/manifests/v3.stage_protocol_shape_contract.yml',
	      'docs/design/v3-stage-protocol-shape-contract.md',
	      'docs/architecture/v3-mainline-call-map.yml',
	      'package.json',
	      'scripts/architecture/verify-v3-architecture-ci.mjs',
	      'v3/crates/routecodex-v3-runtime/src/hub_v1',
	      'v3/crates/routecodex-v3-runtime/src/kernel.rs',
	      'v3/crates/routecodex-v3-runtime/src/kernel',
	      'v3/crates/routecodex-v3-runtime/src/hooks.rs',
	      'v3/crates/routecodex-v3-server/src/responses_direct_server_outcome.rs',
	      'v3/crates/routecodex-v3-provider-responses/src',
	    ]) {
      const source = path.join(root, relative);
      const target = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
	    }
	    const manifestPath = path.join(tmp, 'docs/architecture/manifests/v3.stage_protocol_shape_contract.yml');
	    const document = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
	    if (mutation.mutateManifest) mutation.mutateManifest(document);
	    fs.writeFileSync(manifestPath, YAML.stringify(document));
	    if (mutation.mutateMainline) {
	      const mainlinePath = path.join(tmp, 'docs/architecture/v3-mainline-call-map.yml');
	      const mainline = YAML.parse(fs.readFileSync(mainlinePath, 'utf8'));
	      mutation.mutateMainline(mainline);
	      fs.writeFileSync(mainlinePath, YAML.stringify(mainline));
	    }
	    if (mutation.mutateSource) mutation.mutateSource(tmp);
	    const result = verifyV3StageProtocolShapes(tmp).join('\n');
    if (!expected.test(result)) {
      failed += 1;
      console.error(`[v3-stage-protocol-shapes-red] ${name}: expected ${expected}, got ${result || '<green>'}`);
    } else {
      console.log(`[v3-stage-protocol-shapes-red] ${name}: failed as expected`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (failed > 0) process.exit(1);
