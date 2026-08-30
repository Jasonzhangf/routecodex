#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const REQUIRED_CHAINS = new Map([
  ['direct_request', ['V4DirectReq01ClientProtocol', 'V4DirectReq02RelayContainer', 'V4DirectReq03ProviderWire']],
  ['direct_response', ['V4DirectResp01ProviderRaw', 'V4DirectResp02RelayContainer', 'V4DirectResp03ClientProtocol']],
  ['relay_request', [
    'V4ServerReqInbound01ClientRaw',
    'V4HubReqInbound02Normalized',
    'V4HubReqChatProcess03Governed',
    'V4HubReqExecution04Planned',
    'V4HubReqTarget05Resolved',
    'V4HubReqOutbound06ProviderSemantic',
    'V4ProviderReqCompat07ProviderCompat',
    'V4ProviderReqOutbound08WirePayload',
    'V4ProviderReqOutbound09TransportRequest',
  ]],
  ['relay_response', [
    'V4ProviderRespInbound01Raw',
    'V4ProviderRespCompat02ProviderCompat',
    'V4HubRespInbound03Normalized',
    'V4HubRespChatProcess04Governed',
    'V4HubRespOutbound05ClientSemantic',
    'V4ServerRespOutbound06ClientFrame',
  ]],
]);

const DIRECT_REQUEST_HOOK = 'v4.hook.direct.request';
const DIRECT_RESPONSE_HOOK = 'v4.hook.direct.response';
const RELAY_REQUEST_HOOK = 'v4.hook.relay.request';
const RELAY_RESPONSE_HOOK = 'v4.hook.relay.response';
const SSE_INGRESS = 'v4.transport.sse.ingress';
const SSE_EGRESS = 'v4.transport.sse.egress';

function chainMap(plan) {
  return new Map((plan.chains ?? []).map((chain) => [chain.chain_id, chain]));
}

function pluginEntries(chain) {
  return (chain?.nodes ?? []).flatMap((node) =>
    (node.plugins ?? []).map((plugin) => ({ nodeId: node.node_id, ...plugin })));
}

function validate(plan, functionMap, resourceMap, mainlineMap, verificationMap, sources) {
  const failures = [];
  const chains = chainMap(plan);

  for (const [chainId, expectedNodes] of REQUIRED_CHAINS) {
    const chain = chains.get(chainId);
    if (!chain) {
      failures.push(`missing chain ${chainId}`);
      continue;
    }
    const actualNodes = (chain.nodes ?? []).map((node) => node.node_id);
    if (actualNodes.join('\n') !== expectedNodes.join('\n')) {
      failures.push(`${chainId} node topology mismatch`);
    }
  }

  for (const forbidden of ['request', 'response']) {
    if (chains.has(forbidden)) failures.push(`combined ${forbidden} chain is forbidden`);
  }

  const directRequestPlugins = pluginEntries(chains.get('direct_request'));
  const directResponsePlugins = pluginEntries(chains.get('direct_response'));
  const relayRequestPlugins = pluginEntries(chains.get('relay_request'));
  const relayResponsePlugins = pluginEntries(chains.get('relay_response'));

  const requirePlugin = (entries, pluginId, lane) => {
    if (!entries.some((entry) => entry.plugin_id === pluginId)) {
      failures.push(`${lane} missing ${pluginId}`);
    }
  };
  requirePlugin(directRequestPlugins, DIRECT_REQUEST_HOOK, 'direct_request');
  requirePlugin(directResponsePlugins, DIRECT_RESPONSE_HOOK, 'direct_response');
  requirePlugin(relayRequestPlugins, RELAY_REQUEST_HOOK, 'relay_request');
  requirePlugin(relayResponsePlugins, RELAY_RESPONSE_HOOK, 'relay_response');

  const rejectPlugin = (entries, pluginId, lane) => {
    if (entries.some((entry) => entry.plugin_id === pluginId)) {
      failures.push(`${lane} cross-mounts ${pluginId}`);
    }
  };
  rejectPlugin(directRequestPlugins, RELAY_REQUEST_HOOK, 'direct_request');
  rejectPlugin(directResponsePlugins, RELAY_RESPONSE_HOOK, 'direct_response');
  rejectPlugin(relayRequestPlugins, DIRECT_REQUEST_HOOK, 'relay_request');
  rejectPlugin(relayResponsePlugins, DIRECT_RESPONSE_HOOK, 'relay_response');

  const allPlugins = [...chains.values()].flatMap(pluginEntries);
  for (const pluginId of [SSE_INGRESS, SSE_EGRESS]) {
    const matches = allPlugins.filter((entry) => entry.plugin_id === pluginId);
    if (matches.length === 0) failures.push(`missing independent SSE plugin ${pluginId}`);
    for (const match of matches) {
      if ((match.effects ?? []).join(',') !== 'transport') {
        failures.push(`${pluginId} must declare only transport effect`);
      }
      if ((match.writes ?? []).some((resource) => /payload|semantic|model/i.test(resource))) {
        failures.push(`${pluginId} writes semantic payload resource`);
      }
    }
  }

  const requiredFunctionIds = [
    'v4.transport.sse_plugin',
    'v4.direct.relay_container',
    'v4.hook.direct.request_response',
    'v4.hook.relay.request_response',
  ];
  for (const functionId of requiredFunctionIds) {
    if (!(functionMap.functions ?? []).some((entry) => entry.function_id === functionId)) {
      failures.push(`function map missing ${functionId}`);
    }
  }

  const requiredResources = [
    'v4.transport.sse_frames',
    'v4.execution.direct_relay_container',
    'v4.information.execution_lane',
    'v4.information.client_protocol',
    'v4.information.provider_protocol',
  ];
  for (const resourceId of requiredResources) {
    if (!(resourceMap.resources ?? []).some((entry) => entry.resource_id === resourceId)) {
      failures.push(`resource map missing ${resourceId}`);
    }
  }

  const requiredEdgeTypes = [
    'typed_lane_to_direct_relay',
    'direct_request_hook_execution',
    'direct_response_hook_execution',
    'relay_request_adjacent_projection',
    'relay_response_adjacent_projection',
    'sse_transport_frame_handoff',
  ];
  for (const edgeType of requiredEdgeTypes) {
    if (!(mainlineMap.edges ?? []).some((entry) => entry.edge_type === edgeType)) {
      failures.push(`mainline map missing ${edgeType}`);
    }
  }

  for (const gateId of ['v4_direct_relay_sse', 'v4_direct_relay_sse_red']) {
    if (!(verificationMap.gates ?? []).some((entry) => entry.gate_id === gateId)) {
      failures.push(`verification map missing ${gateId}`);
    }
  }

  const forbiddenRuntimePatterns = [
    ['runtime', /project_chat_request_to_responses\s*\(/],
    ['runtime', /project_responses_(?:event|json|usage)_to_chat\s*\(/],
    ['runtime-bin', /normalize_provider_sse_frame\s*\(/],
    ['runtime-bin', /normalize_provider_response\s*\(/],
  ];
  for (const [sourceId, pattern] of forbiddenRuntimePatterns) {
    if (pattern.test(sources[sourceId] ?? '')) {
      failures.push(`${sourceId} owns forbidden payload projection ${pattern}`);
    }
  }

  if (/\b(?:continuation_classify|continuation_restore|continuation_commit)\b/.test(sources.runtime ?? '')) {
    failures.push('runtime-local continuation operators are forbidden');
  }
  if (/\.get\("protocol"\)|\["protocol"\]/.test(sources.modelHooks ?? '')) {
    failures.push('hook infers protocol from payload');
  }

  for (const symbol of [
    'pub struct SseTransportFrame',
    'pub struct SseIngressPlugin',
    'pub struct SseEgressPlugin',
  ]) {
    if (!(sources.sseTransport ?? '').includes(symbol)) {
      failures.push(`SSE transport plugin missing ${symbol}`);
    }
  }
  if (/serde_json|serde::|\bValue\b/.test(sources.sseTransport ?? '')) {
    failures.push('SSE transport plugin reads semantic payload');
  }
  for (const symbol of [
    'pub struct DirectRelayInformation',
    'pub trait DirectRequestHook',
    'pub trait DirectResponseHook',
    'pub struct DirectRelayContainer',
    'pub fn execute_request(',
    'pub fn execute_response(',
  ]) {
    if (!(sources.directRelay ?? '').includes(symbol)) {
      failures.push(`DirectRelay container missing ${symbol}`);
    }
  }
  if (!(sources.directRelay ?? '').includes('pub type SharedPayload = Arc<Value>')) {
    failures.push('DirectRelay container does not use shared payload ownership');
  }

  const directContract = plan.direct_protocol_contract ?? {};
  if (directContract.same_protocol !== true || directContract.mismatch !== 'fail_fast') {
    failures.push('Direct same-protocol fail-fast contract missing');
  }
  const protocolContract = plan.protocol_information_contract ?? {};
  if (protocolContract.client_provider_independent !== true || protocolContract.payload_inference !== 'forbidden') {
    failures.push('client/provider typed protocol independence contract missing');
  }

  return failures;
}

function fixture() {
  const chain = (chainId, nodeIds, pluginByNode) => ({
    chain_id: chainId,
    nodes: nodeIds.map((nodeId, index) => ({
      node_id: nodeId,
      position: index + 1,
      plugins: pluginByNode[nodeId] ?? [],
    })),
  });
  const plan = {
    chains: [
      chain('direct_request', REQUIRED_CHAINS.get('direct_request'), {
        V4DirectReq02RelayContainer: [{ plugin_id: DIRECT_REQUEST_HOOK, effects: ['semantic'] }],
      }),
      chain('direct_response', REQUIRED_CHAINS.get('direct_response'), {
        V4DirectResp01ProviderRaw: [{ plugin_id: SSE_INGRESS, effects: ['transport'], writes: [] }],
        V4DirectResp02RelayContainer: [{ plugin_id: DIRECT_RESPONSE_HOOK, effects: ['semantic'] }],
        V4DirectResp03ClientProtocol: [{ plugin_id: SSE_EGRESS, effects: ['transport'], writes: [] }],
      }),
      chain('relay_request', REQUIRED_CHAINS.get('relay_request'), {
        V4HubReqOutbound06ProviderSemantic: [{ plugin_id: RELAY_REQUEST_HOOK, effects: ['semantic'] }],
      }),
      chain('relay_response', REQUIRED_CHAINS.get('relay_response'), {
        V4ProviderRespInbound01Raw: [{ plugin_id: SSE_INGRESS, effects: ['transport'], writes: [] }],
        V4HubRespOutbound05ClientSemantic: [{ plugin_id: RELAY_RESPONSE_HOOK, effects: ['semantic'] }],
        V4ServerRespOutbound06ClientFrame: [{ plugin_id: SSE_EGRESS, effects: ['transport'], writes: [] }],
      }),
    ],
    direct_protocol_contract: { same_protocol: true, mismatch: 'fail_fast' },
    protocol_information_contract: { client_provider_independent: true, payload_inference: 'forbidden' },
  };
  return {
    plan,
    functionMap: { functions: [
      { function_id: 'v4.transport.sse_plugin' },
      { function_id: 'v4.direct.relay_container' },
      { function_id: 'v4.hook.direct.request_response' },
      { function_id: 'v4.hook.relay.request_response' },
    ] },
    resourceMap: { resources: [
      { resource_id: 'v4.transport.sse_frames' },
      { resource_id: 'v4.execution.direct_relay_container' },
      { resource_id: 'v4.information.execution_lane' },
      { resource_id: 'v4.information.client_protocol' },
      { resource_id: 'v4.information.provider_protocol' },
    ] },
    mainlineMap: { edges: [
      { edge_type: 'typed_lane_to_direct_relay' },
      { edge_type: 'direct_request_hook_execution' },
      { edge_type: 'direct_response_hook_execution' },
      { edge_type: 'relay_request_adjacent_projection' },
      { edge_type: 'relay_response_adjacent_projection' },
      { edge_type: 'sse_transport_frame_handoff' },
    ] },
    verificationMap: { gates: [
      { gate_id: 'v4_direct_relay_sse' },
      { gate_id: 'v4_direct_relay_sse_red' },
    ] },
    sources: {
      runtime: '',
      'runtime-bin': '',
      modelHooks: '',
      sseTransport: [
        'pub struct SseTransportFrame',
        'pub struct SseIngressPlugin',
        'pub struct SseEgressPlugin',
      ].join('\n'),
      directRelay: [
        'pub type SharedPayload = Arc<Value>',
        'pub struct DirectRelayInformation',
        'pub trait DirectRequestHook',
        'pub trait DirectResponseHook',
        'pub struct DirectRelayContainer',
        'pub fn execute_request(',
        'pub fn execute_response(',
      ].join('\n'),
    },
  };
}

function redSelfTest() {
  const cases = [
    ['combined lane', (data) => data.plan.chains.push({ chain_id: 'request', nodes: [] }), 'combined request'],
    ['missing Direct relay node', (data) => data.plan.chains[0].nodes.splice(1, 1), 'topology mismatch'],
    ['Direct mounts Relay hook', (data) => data.plan.chains[0].nodes[1].plugins.push({ plugin_id: RELAY_REQUEST_HOOK, effects: ['semantic'] }), 'cross-mounts'],
    ['Relay mounts Direct hook', (data) => data.plan.chains[2].nodes[5].plugins.push({ plugin_id: DIRECT_REQUEST_HOOK, effects: ['semantic'] }), 'cross-mounts'],
    ['SSE semantic effect', (data) => { data.plan.chains[1].nodes[0].plugins[0].effects = ['semantic']; }, 'only transport'],
    ['SSE payload write', (data) => { data.plan.chains[1].nodes[0].plugins[0].writes = ['v4.response.normal_payload']; }, 'semantic payload'],
    ['runtime payload projection', (data) => { data.sources.runtime = 'project_chat_request_to_responses(&value)'; }, 'forbidden payload projection'],
    ['runtime local continuation', (data) => { data.sources.runtime = 'continuation_restore'; }, 'runtime-local continuation'],
    ['hook protocol payload inference', (data) => { data.sources.modelHooks = 'value.get("protocol")'; }, 'infers protocol'],
    ['Direct protocol fallback', (data) => { data.plan.direct_protocol_contract.mismatch = 'relay'; }, 'same-protocol'],
    ['client/provider coupling', (data) => { data.plan.protocol_information_contract.client_provider_independent = false; }, 'typed protocol independence'],
    ['SSE semantic parser', (data) => { data.sources.sseTransport += '\nuse serde_json::Value;'; }, 'reads semantic payload'],
    ['Direct shared payload removed', (data) => { data.sources.directRelay = data.sources.directRelay.replace('pub type SharedPayload = Arc<Value>', 'pub type SharedPayload = Value'); }, 'shared payload ownership'],
  ];
  for (const [name, mutate, expected] of cases) {
    const data = structuredClone(fixture());
    mutate(data);
    const failures = validate(data.plan, data.functionMap, data.resourceMap, data.mainlineMap, data.verificationMap, data.sources);
    if (!failures.some((failure) => failure.includes(expected))) {
      throw new Error(`${name}: expected failure containing ${expected}; got ${failures.join(' | ')}`);
    }
  }
  console.log(`V4_DIRECT_RELAY_SSE_RED_OK cases=${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  redSelfTest();
} else {
  const failures = validate(
    readJson('contracts/skeleton-plan.contract.json'),
    readJson('docs/architecture/maps/function-map.json'),
    readJson('docs/architecture/maps/resource-map.json'),
    readJson('docs/architecture/maps/mainline-call-map.json'),
    readJson('docs/architecture/maps/verification-map.json'),
    {
      runtime: readText('crates/routecodex-v4-runtime/src/lib.rs'),
      'runtime-bin': readText('crates/routecodex-v4-runtime-bin/src/main.rs'),
      modelHooks: readText('crates/routecodex-v4-standard-plugins/src/model_hooks.rs'),
      sseTransport: readText('crates/routecodex-v4-standard-plugins/src/sse_transport.rs'),
      directRelay: readText('crates/routecodex-v4-node-container/src/direct_relay.rs'),
    },
  );
  if (failures.length > 0) {
    console.error('V4_DIRECT_RELAY_SSE_GATE_FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('V4_DIRECT_RELAY_SSE_GATE_OK');
}
