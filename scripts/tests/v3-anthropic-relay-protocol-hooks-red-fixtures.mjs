#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(
  repoRoot,
  'scripts/architecture/verify-v3-anthropic-relay-protocol-hooks.mjs',
);
const source = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs';
const tests = 'v3/crates/routecodex-v3-runtime/tests/hub_anthropic_relay_protocol_hooks.rs';
const fixtures = [
  [
    'request static callback removed',
    source,
    'req_inbound: run_v3_anthropic_relay_req_inbound_hook',
    'req_inbound: removed_request_callback',
    /missing req_inbound: run_v3_anthropic_relay_req_inbound_hook/,
  ],
  [
    'client projection static callback removed',
    source,
    'client_projection: run_v3_anthropic_relay_client_projection_hook',
    'client_projection: removed_client_projection_callback',
    /missing client_projection: run_v3_anthropic_relay_client_projection_hook/,
  ],
  [
    'client side-channel validator removed',
    source,
    'validate_v3_anthropic_hub_response_payload_for_client_projection',
    'unchecked_client_projection_payload',
    /missing validate_v3_anthropic_hub_response_payload_for_client_projection/,
  ],
  [
    'request inbound responses semantic codec removed',
    source,
    'encode_v3_anthropic_request_as_responses_semantic',
    'characterize_v3_anthropic_client_input_to_hub_semantic',
    /missing encode_v3_anthropic_request_as_responses_semantic/,
  ],
  [
    'entry protocol guard inverted',
    source,
    'entry_protocol != V3HubEntryProtocol::Anthropic',
    'entry_protocol == V3HubEntryProtocol::Anthropic',
    /missing entry_protocol != V3HubEntryProtocol::Anthropic/,
  ],
  [
    'Relay execution guard inverted',
    source,
    'execution != V3HubExecutionMode::Relay',
    'execution == V3HubExecutionMode::Relay',
    /missing execution != V3HubExecutionMode::Relay/,
  ],
  [
    'Responses provider wire replaced by Anthropic',
    source,
    'provider_wire_protocol != V3HubProviderWireProtocol::Responses',
    'provider_wire_protocol != V3HubProviderWireProtocol::Anthropic',
    /missing provider_wire_protocol != V3HubProviderWireProtocol::Responses|forbidden.*V3HubProviderWireProtocol::Anthropic/,
  ],
  [
    'side-channel negative coverage removed',
    tests,
    '"metadata_center"',
    '"metadata_removed"',
    /missing metadata_center/,
  ],
  [
    'wrong protocol negative coverage removed',
    tests,
    'V3HubProviderWireProtocol::Anthropic,',
    'V3HubProviderWireProtocol::Gemini,',
    /missing V3HubProviderWireProtocol::Anthropic/,
  ],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-anthropic-relay-hooks-red-'));
  try {
    for (const directory of ['v3', 'scripts']) {
      cpSync(resolve(repoRoot, directory), join(root, directory), {
        recursive: true,
        filter: (path) => !path.includes('/target/'),
      });
    }
    const target = join(root, relative);
    const text = readFileSync(target, 'utf8');
    if (!text.includes(from)) throw new Error(`${name}: fixture source missing`);
    writeFileSync(target, text.split(from).join(to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-anthropic-relay-protocol-hooks-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `[test:v3-anthropic-relay-protocol-hooks-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`,
);
