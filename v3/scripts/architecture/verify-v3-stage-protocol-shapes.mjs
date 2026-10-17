#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const MANIFEST = 'docs/architecture/manifests/v3.stage_protocol_shape_contract.yml';
const MAINLINE = 'docs/architecture/v3-mainline-call-map.yml';
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REQUIRED_CHAINS = new Map([
  ['v3.relay.request.stage_shapes', [
    ['V3HubReqInbound01ClientRaw', 'source_request_wire', 'source_request_wire'],
    ['V3HubReqInbound02Normalized', 'source_request_wire', 'canonical_chat_request'],
    ['V3HubReqChatProcess04Governed', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqExecution05Planned', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqTarget06Resolved', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqOutbound07ProviderSemantic', 'canonical_chat_request', 'canonical_chat_request'],
    ['ProviderReqCompat06ProviderCompat', 'canonical_chat_request', 'provider_request_semantic'],
    ['V3ProviderReqOutbound08WirePayload', 'provider_request_semantic', 'provider_request_wire'],
    ['V3ProviderReqOutbound09TransportRequest', 'provider_request_wire', 'provider_request_wire'],
  ]],
  ['v3.relay.response.stage_shapes', [
    ['V3ProviderRespInbound01Raw', 'provider_response_wire', 'provider_response_wire'],
    ['ProviderRespCompat02ProviderCompat', 'provider_response_wire', 'provider_response_wire'],
    ['V3HubRespInbound02Normalized', 'provider_response_wire', 'canonical_chat_response'],
    ['V3HubRespChatProcess03Governed', 'canonical_chat_response', 'canonical_chat_response'],
    ['V3HubRespOutbound05ClientSemantic', 'canonical_chat_response', 'client_response_semantic'],
    ['V3ServerRespOutbound06ClientFrame', 'client_response_semantic', 'client_response_semantic'],
  ]],
  ['v3.direct.same_protocol.stage_shapes', [
    ['V3ResponsesDirect11Policy', 'same_protocol_request', 'same_protocol_request'],
    ['V3Provider12ResponsesWirePayload', 'same_protocol_request', 'same_protocol_request'],
    ['V3Transport13ResponsesHttpRequest', 'same_protocol_request', 'same_protocol_request'],
    ['V3ProviderResp14Raw', 'same_protocol_response', 'same_protocol_response'],
    ['V3DirectResp14ProviderProjectionPrepared', 'same_protocol_response', 'same_protocol_response'],
    ['V3DirectResp15ClientPayloadReady', 'same_protocol_response', 'same_protocol_response'],
  ]],
]);

export function verifyV3StageProtocolShapes(root = defaultRoot) {
  const failures = [];
  for (const relative of [MANIFEST, MAINLINE]) {
    if (!fs.existsSync(path.join(root, relative))) failures.push(`missing ${relative}`);
  }
  if (failures.length) return failures;
  const load = (relative) => YAML.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const manifest = load(MANIFEST);
  const mainline = load(MAINLINE);
  if (manifest?.status !== 'active') failures.push(`${MANIFEST}: status must be active`);
  if (manifest?.rules?.direct_same_protocol?.protocol_identity !== 'same_as_entry') {
    failures.push(`${MANIFEST}: Direct protocol identity must remain same_as_entry`);
  }
  if (manifest?.rules?.control_fields?.carrier !== 'typed_side_channel_only'
    || !(manifest?.rules?.control_fields?.forbidden_in_payload ?? []).includes('metadata_center')) {
    failures.push(`${MANIFEST}: control fields must remain typed-side-channel-only and forbidden in payload`);
  }
  const shapes = manifest?.shape_contracts ?? {};
  for (const shape of new Set([...REQUIRED_CHAINS.values()].flatMap((rows) => rows.flatMap((row) => row.slice(1))))) {
    if (!shapes[shape]?.field_registry) failures.push(`${MANIFEST}: shape ${shape} must bind a field_registry`);
  }
  const chains = new Map((manifest?.chains ?? []).map((chain) => [chain.chain_id, chain]));
  const edges = new Map((mainline?.chains ?? []).flatMap((chain) => chain.edges ?? []).map((edge) => [edge.step_id, edge]));
  for (const [chainId, expected] of REQUIRED_CHAINS) {
    const chain = chains.get(chainId);
    if (!chain) {
      failures.push(`${MANIFEST}: missing chain ${chainId}`);
      continue;
    }
    if (chain.stages?.length !== expected.length) {
      failures.push(`${MANIFEST}: ${chainId} stage count must be ${expected.length}`);
      continue;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const stage = chain.stages[index];
      const [nodeId, entryShape, exitShape] = expected[index];
      if (stage?.node_id !== nodeId || stage?.entry_shape !== entryShape || stage?.exit_shape !== exitShape) {
        failures.push(`${MANIFEST}: ${chainId}[${index}] must be ${nodeId} ${entryShape} -> ${exitShape}`);
      }
      const transportBoundary = chainId === 'v3.direct.same_protocol.stage_shapes' && nodeId === 'V3ProviderResp14Raw';
      if (index > 0 && !transportBoundary && chain.stages[index - 1]?.exit_shape !== stage?.entry_shape) {
        failures.push(`${MANIFEST}: ${chainId} shape discontinuity before ${nodeId}`);
      }
    }
    const steps = chain.mainline_step_ids ?? [];
    if (steps.length !== expected.length - 1) {
      failures.push(`${MANIFEST}: ${chainId} must bind ${expected.length - 1} adjacent mainline steps`);
    } else {
      for (let index = 0; index < steps.length; index += 1) {
        const edge = edges.get(steps[index]);
        const from = expected[index][0];
        const to = expected[index + 1][0];
        if (!edge || edge.status !== 'anchored' || edge.from_node !== from || edge.to_node !== to) {
          failures.push(`${MAINLINE}: ${steps[index]} must be anchored ${from} -> ${to}`);
        }
      }
    }
  }
  const direct = chains.get('v3.direct.same_protocol.stage_shapes');
  if (direct?.protocol_identity !== 'same_as_entry') failures.push(`${MANIFEST}: Direct chain must declare same_as_entry`);
  if ((direct?.stages ?? []).some((stage) => !stage.entry_shape?.startsWith('same_protocol_') || stage.entry_shape !== stage.exit_shape)) {
    failures.push(`${MANIFEST}: every Direct stage must preserve its same-protocol shape`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = verifyV3StageProtocolShapes();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('[verify:v3-stage-protocol-shapes] PASS: declared Direct/Relay shape and mainline contracts');
}
