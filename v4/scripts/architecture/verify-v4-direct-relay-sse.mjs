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
const SSE_TRANSPORT_NODE = 'V4TransportSsePlugin';
const SSE_TRANSPORT_OWNER = 'routecodex-v4-standard-plugins::sse_transport';
const REQUIRED_TRANSPORT_PLUGINS = new Map([
  [SSE_INGRESS, { direction: 'ingress', attachment: 'provider_response' }],
  [SSE_EGRESS, { direction: 'egress', attachment: 'client_response' }],
]);

function chainMap(plan) {
  return new Map((plan.chains ?? []).map((chain) => [chain.chain_id, chain]));
}

function pluginEntries(chain) {
  return (chain?.nodes ?? []).flatMap((node) =>
    (node.plugins ?? []).map((plugin) => ({ nodeId: node.node_id, ...plugin })));
}

function validate(plan, nodeGraph, functionMap, resourceMap, mainlineMap, verificationMap, sources) {
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
  requirePlugin(relayRequestPlugins, RELAY_REQUEST_HOOK, 'relay_request');
  requirePlugin(relayResponsePlugins, RELAY_RESPONSE_HOOK, 'relay_response');
  const requireSinglePlugin = (entries, pluginId, lane) => {
    const count = entries.filter((entry) => entry.plugin_id === pluginId).length;
    if (count !== 1) failures.push(`${lane} must mount ${pluginId} exactly once; found ${count}`);
  };
  requireSinglePlugin(directRequestPlugins, DIRECT_REQUEST_HOOK, 'direct_request');
  requireSinglePlugin(directResponsePlugins, DIRECT_RESPONSE_HOOK, 'direct_response');

  for (const [chainId, nodeId] of [
    ['direct_request', 'V4DirectReq02RelayContainer'],
    ['direct_response', 'V4DirectResp02RelayContainer'],
  ]) {
    const checkpoint = (chains.get(chainId)?.checkpoints ?? [])
      .find((entry) => entry.node_id === nodeId);
    if (!checkpoint || checkpoint.owner !== 'routecodex-v4-node-container::NodeContainer') {
      failures.push(`${nodeId} checkpoint must be owned by generic NodeContainer`);
    }
  }

  const rejectPlugin = (entries, pluginId, lane) => {
    if (entries.some((entry) => entry.plugin_id === pluginId)) {
      failures.push(`${lane} cross-mounts ${pluginId}`);
    }
  };
  rejectPlugin(directRequestPlugins, RELAY_REQUEST_HOOK, 'direct_request');
  rejectPlugin(directResponsePlugins, RELAY_RESPONSE_HOOK, 'direct_response');
  rejectPlugin(relayRequestPlugins, DIRECT_REQUEST_HOOK, 'relay_request');
  rejectPlugin(relayResponsePlugins, DIRECT_RESPONSE_HOOK, 'relay_response');

  const allNodePlugins = [...chains.values()].flatMap(pluginEntries);
  for (const pluginId of REQUIRED_TRANSPORT_PLUGINS.keys()) {
    if (allNodePlugins.some((entry) => entry.plugin_id === pluginId)) {
      failures.push(`${pluginId} is mounted in semantic NodeSlot.plugins`);
    }
  }
  const transportPlugins = plan.transport_plugins ?? [];
  for (const [pluginId, contract] of REQUIRED_TRANSPORT_PLUGINS) {
    const matches = transportPlugins.filter((entry) => entry.plugin_id === pluginId);
    if (matches.length !== 1) {
      failures.push(`compiled transport registration ${pluginId} must exist exactly once; found ${matches.length}`);
      continue;
    }
    const [binding] = matches;
    if (binding.node_id !== SSE_TRANSPORT_NODE
        || binding.owner !== SSE_TRANSPORT_OWNER
        || binding.direction !== contract.direction
        || binding.attachment !== contract.attachment
        || binding.effect !== 'transport'
        || binding.resource_id !== 'v4.transport.sse_frames') {
      failures.push(`${pluginId} compiled transport registration drift`);
    }
    if ((binding.writes ?? []).length !== 0) {
      failures.push(`${pluginId} writes semantic payload resource`);
    }
  }
  if (transportPlugins.length !== REQUIRED_TRANSPORT_PLUGINS.size) {
    failures.push(`compiled transport registration count drift; found ${transportPlugins.length}`);
  }

  const registeredTransportNode = (nodeGraph.registered_nodes ?? [])
    .find((entry) => entry.node_id === SSE_TRANSPORT_NODE);
  if (!registeredTransportNode
      || registeredTransportNode.family !== 'TransportPluginNode'
      || registeredTransportNode.role_id !== 'sse_transport'
      || registeredTransportNode.owner !== 'routecodex-v4-standard-plugins') {
    failures.push('node graph missing compiled V4TransportSsePlugin ownership');
  }

  const requiredFunctionIds = [
    'v4.transport.sse_plugin',
    'v4.runtime.sse_response_pipeline',
    'v4.direct.relay_container',
    'v4.hook.direct.request_response',
    'v4.hook.relay.request_response',
  ];
  for (const functionId of requiredFunctionIds) {
    if (!(functionMap.functions ?? []).some((entry) => entry.function_id === functionId)) {
      failures.push(`function map missing ${functionId}`);
    }
  }
  const directContainerFunction = (functionMap.functions ?? [])
    .find((entry) => entry.function_id === 'v4.direct.relay_container');
  if (directContainerFunction) {
    if (directContainerFunction.owner !== 'routecodex-v4-node-container::NodeContainer') {
      failures.push('Direct relay node must be owned by generic NodeContainer');
    }
    for (const symbol of [
      'ExecutionEngine::execute_pinned_node',
      'EpochLease::execute',
      'NodeContainer::execute_with_plan_hash',
    ]) {
      if (!(directContainerFunction.entry_symbols ?? []).includes(symbol)) {
        failures.push(`Direct relay node function map missing ${symbol}`);
      }
    }
    if ((directContainerFunction.source_paths ?? [])
      .some((sourcePath) => sourcePath.includes('direct_relay.rs') || sourcePath.includes('runtime-bin'))) {
      failures.push('Direct relay node function map registers a second execution surface');
    }
  }
  const transportFunction = (functionMap.functions ?? [])
    .find((entry) => entry.function_id === 'v4.transport.sse_plugin');
  if (transportFunction?.status !== 'active' || transportFunction?.owner !== SSE_TRANSPORT_OWNER) {
    failures.push('SSE transport function must be active under the transport owner');
  }
  const streamPipelineFunction = (functionMap.functions ?? [])
    .find((entry) => entry.function_id === 'v4.runtime.sse_response_pipeline');
  for (const symbol of [
    'ResponseStreamProcessor::process_frame',
    'ResponseStreamProcessor::finish',
    'ResponseStreamProcessor::project_failure',
  ]) {
    if (streamPipelineFunction && !(streamPipelineFunction.entry_symbols ?? []).includes(symbol)) {
      failures.push(`SSE response pipeline function map missing ${symbol}`);
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
  const directContainerResource = (resourceMap.resources ?? [])
    .find((entry) => entry.resource_id === 'v4.execution.direct_relay_container');
  if (directContainerResource
      && directContainerResource.owner !== 'routecodex-v4-node-container::NodeContainer') {
    failures.push('Direct relay resource must be owned by generic NodeContainer');
  }
  const sseResource = (resourceMap.resources ?? [])
    .find((entry) => entry.resource_id === 'v4.transport.sse_frames');
  if (!sseResource || sseResource.status !== 'active' || sseResource.owner !== 'routecodex-v4-standard-plugins::SseTransportFrame') {
    failures.push('SSE transport resource is not active under SseTransportFrame');
  }
  const dispositionResource = (resourceMap.resources ?? [])
    .find((entry) => entry.resource_id === 'v4.event.response_stream_disposition');
  if (!dispositionResource || dispositionResource.status !== 'active'
      || dispositionResource.owner !== 'routecodex-v4-runtime::ResponseStreamDisposition') {
    failures.push('typed response stream disposition event resource missing');
  }

  const requiredEdgeTypes = [
    'typed_lane_to_direct_relay',
    'direct_request_hook_execution',
    'direct_response_hook_execution',
    'relay_request_adjacent_projection',
    'relay_response_adjacent_projection',
    'sse_transport_frame_handoff',
    'sse_transport_to_runtime_codec',
    'sse_runtime_to_transport_egress',
  ];
  for (const edgeType of requiredEdgeTypes) {
    if (!(mainlineMap.edges ?? []).some((entry) => entry.edge_type === edgeType)) {
      failures.push(`mainline map missing ${edgeType}`);
    }
  }
  for (const edge of (mainlineMap.edges ?? []).filter((entry) => [
    'typed_lane_to_direct_relay',
    'direct_request_hook_execution',
    'direct_response_hook_execution',
  ].includes(entry.edge_type))) {
    const serialized = JSON.stringify(edge);
    if (serialized.includes('DirectRelayContainer') || serialized.includes('direct_relay.rs')) {
      failures.push(`${edge.edge_type} mainline edge registers a second Direct execution surface`);
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

  const forbiddenSecondDirectSurfacePatterns = [
    /\bDirectRelayContainer\b/,
    /\bDirectRequestPassthrough\b/,
    /\bDirectResponsePassthrough\b/,
    /\bdirect_relay\s*\.\s*execute_(?:request|response)\s*\(/,
  ];
  for (const pattern of forbiddenSecondDirectSurfacePatterns) {
    if (pattern.test(sources['runtime-bin'] ?? '')) {
      failures.push(`runtime-bin owns forbidden second Direct execution surface ${pattern}`);
    }
  }
  if (/\bpub\s+mod\s+direct_relay\b|\bpub\s+struct\s+DirectRelayContainer\b/
    .test(sources.nodeContainer ?? '')) {
    failures.push('node-container exposes forbidden dedicated DirectRelayContainer implementation');
  }
  if (!(sources.runtime ?? '').includes('ExecutionEngine::execute_pinned_node')) {
    failures.push('runtime Direct chain does not enter ExecutionEngine::execute_pinned_node');
  }
  for (const symbol of ['pub struct NodeContainer', 'pub fn execute_with_plan_hash']) {
    if (!(sources.nodeContainer ?? '').includes(symbol)) {
      failures.push(`generic NodeContainer execution surface missing ${symbol}`);
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
    'pub enum ResponseStreamDisposition',
    'pub struct ResponseStreamProcessor',
    'pub fn process_frame(',
    'pub fn finish(',
    'pub fn project_failure(',
  ]) {
    if (!(sources.runtime ?? '').includes(symbol)) {
      failures.push(`runtime SSE response owner missing ${symbol}`);
    }
  }
  for (const symbol of [
    'pub struct ResponsesSseFrame',
    'pub fn parse_responses_sse_frame(',
    'pub fn validate_responses_sse_frame(',
  ]) {
    if ((sources.runtime ?? '').includes(symbol)) {
      failures.push(`runtime duplicates provider SSE codec ${symbol}`);
    }
  }
  const runtimeBinStream = (sources['runtime-bin'] ?? '')
    .match(/struct ResponsesSseStream[\s\S]*?\nfn project_fault/)?.[0] ?? '';
  for (const [pattern, label] of [
    [/serde_json|decode_provider_sse_frame|encode_client_sse_frame|encode_client_error_sse_frame/, 'semantic codec'],
    [/validate_responses_sse_frame|response\.completed|response\.failed|event:/, 'provider event parsing'],
    [/terminal_seen|chat_role_emitted|project_frame|queue_error/, 'semantic stream state'],
  ]) {
    if (pattern.test(runtimeBinStream)) {
      failures.push(`runtime-bin SSE stream owns forbidden ${label}`);
    }
  }
  for (const symbol of ['#[serde(deny_unknown_fields)]', 'pub struct TransportPluginBinding']) {
    if (!(sources.skeleton ?? '').includes(symbol)) {
      failures.push(`skeleton compiled transport contract missing ${symbol}`);
    }
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
    checkpoints: nodeIds
      .filter((nodeId) => nodeId === 'V4DirectReq02RelayContainer'
        || nodeId === 'V4DirectResp02RelayContainer')
      .map((nodeId) => ({
        node_id: nodeId,
        owner: 'routecodex-v4-node-container::NodeContainer',
      })),
  });
  const plan = {
    transport_plugins: [
      {
        plugin_id: SSE_INGRESS,
        node_id: SSE_TRANSPORT_NODE,
        owner: SSE_TRANSPORT_OWNER,
        direction: 'ingress',
        attachment: 'provider_response',
        effect: 'transport',
        resource_id: 'v4.transport.sse_frames',
        writes: [],
      },
      {
        plugin_id: SSE_EGRESS,
        node_id: SSE_TRANSPORT_NODE,
        owner: SSE_TRANSPORT_OWNER,
        direction: 'egress',
        attachment: 'client_response',
        effect: 'transport',
        resource_id: 'v4.transport.sse_frames',
        writes: [],
      },
    ],
    chains: [
      chain('direct_request', REQUIRED_CHAINS.get('direct_request'), {
        V4DirectReq02RelayContainer: [{ plugin_id: DIRECT_REQUEST_HOOK, effects: ['semantic'] }],
      }),
      chain('direct_response', REQUIRED_CHAINS.get('direct_response'), {
        V4DirectResp02RelayContainer: [{ plugin_id: DIRECT_RESPONSE_HOOK, effects: ['semantic'] }],
      }),
      chain('relay_request', REQUIRED_CHAINS.get('relay_request'), {
        V4HubReqOutbound06ProviderSemantic: [{ plugin_id: RELAY_REQUEST_HOOK, effects: ['semantic'] }],
      }),
      chain('relay_response', REQUIRED_CHAINS.get('relay_response'), {
        V4HubRespOutbound05ClientSemantic: [{ plugin_id: RELAY_RESPONSE_HOOK, effects: ['semantic'] }],
      }),
    ],
    direct_protocol_contract: { same_protocol: true, mismatch: 'fail_fast' },
    protocol_information_contract: { client_provider_independent: true, payload_inference: 'forbidden' },
  };
  return {
    plan,
    nodeGraph: { registered_nodes: [{
      node_id: SSE_TRANSPORT_NODE,
      family: 'TransportPluginNode',
      role_id: 'sse_transport',
      owner: 'routecodex-v4-standard-plugins',
    }] },
    functionMap: { functions: [
      { function_id: 'v4.transport.sse_plugin', status: 'active', owner: SSE_TRANSPORT_OWNER },
      {
        function_id: 'v4.runtime.sse_response_pipeline',
        entry_symbols: [
          'ResponseStreamProcessor::process_frame',
          'ResponseStreamProcessor::finish',
          'ResponseStreamProcessor::project_failure',
        ],
      },
      {
        function_id: 'v4.direct.relay_container',
        owner: 'routecodex-v4-node-container::NodeContainer',
        entry_symbols: [
          'ExecutionEngine::execute_pinned_node',
          'EpochLease::execute',
          'NodeContainer::execute_with_plan_hash',
        ],
        source_paths: [
          'crates/routecodex-v4-runtime/src/execution_engine.rs',
          'crates/routecodex-v4-node-container/src/lib.rs',
        ],
      },
      { function_id: 'v4.hook.direct.request_response' },
      { function_id: 'v4.hook.relay.request_response' },
    ] },
    resourceMap: { resources: [
      { resource_id: 'v4.transport.sse_frames', status: 'active', owner: 'routecodex-v4-standard-plugins::SseTransportFrame' },
      { resource_id: 'v4.event.response_stream_disposition', status: 'active', owner: 'routecodex-v4-runtime::ResponseStreamDisposition' },
      {
        resource_id: 'v4.execution.direct_relay_container',
        owner: 'routecodex-v4-node-container::NodeContainer',
      },
      { resource_id: 'v4.information.execution_lane' },
      { resource_id: 'v4.information.client_protocol' },
      { resource_id: 'v4.information.provider_protocol' },
    ] },
    mainlineMap: { edges: [
      {
        edge_type: 'typed_lane_to_direct_relay',
        to: 'routecodex-v4-node-container::NodeContainer',
        path: 'crates/routecodex-v4-runtime/src/execution_engine.rs,crates/routecodex-v4-node-container/src/lib.rs',
      },
      {
        edge_type: 'direct_request_hook_execution',
        path: 'crates/routecodex-v4-node-container/src/lib.rs,crates/routecodex-v4-standard-plugins/src/model_hooks.rs',
      },
      {
        edge_type: 'direct_response_hook_execution',
        path: 'crates/routecodex-v4-node-container/src/lib.rs,crates/routecodex-v4-standard-plugins/src/model_hooks.rs',
      },
      { edge_type: 'relay_request_adjacent_projection' },
      { edge_type: 'relay_response_adjacent_projection' },
      { edge_type: 'sse_transport_frame_handoff' },
      { edge_type: 'sse_transport_to_runtime_codec' },
      { edge_type: 'sse_runtime_to_transport_egress' },
    ] },
    verificationMap: { gates: [
      { gate_id: 'v4_direct_relay_sse' },
      { gate_id: 'v4_direct_relay_sse_red' },
    ] },
    sources: {
      'runtime-bin': '',
      modelHooks: '',
      sseTransport: [
        'pub struct SseTransportFrame',
        'pub struct SseIngressPlugin',
        'pub struct SseEgressPlugin',
      ].join('\n'),
      runtime: [
        'ExecutionEngine::execute_pinned_node',
        'pub enum ResponseStreamDisposition',
        'pub struct ResponseStreamProcessor',
        'pub fn process_frame(',
        'pub fn finish(',
        'pub fn project_failure(',
      ].join('\n'),
      skeleton: [
        '#[serde(deny_unknown_fields)]',
        'pub struct TransportPluginBinding',
      ].join('\n'),
      nodeContainer: [
        'pub struct NodeContainer',
        'pub fn execute_with_plan_hash',
      ].join('\n'),
    },
  };
}

function redSelfTest() {
  const cases = [
    ['combined lane', (data) => data.plan.chains.push({ chain_id: 'request', nodes: [] }), 'combined request'],
    ['missing Direct relay node', (data) => data.plan.chains[0].nodes.splice(1, 1), 'topology mismatch'],
    ['Direct mounts Relay hook', (data) => data.plan.chains[0].nodes[1].plugins.push({ plugin_id: RELAY_REQUEST_HOOK, effects: ['semantic'] }), 'cross-mounts'],
    ['Direct hook mounted twice', (data) => data.plan.chains[0].nodes[1].plugins.push({ plugin_id: DIRECT_REQUEST_HOOK, effects: ['semantic'] }), 'exactly once'],
    ['Relay mounts Direct hook', (data) => data.plan.chains[2].nodes[5].plugins.push({ plugin_id: DIRECT_REQUEST_HOOK, effects: ['semantic'] }), 'cross-mounts'],
    ['SSE mounted in semantic node', (data) => { data.plan.chains[1].nodes[0].plugins.push({ plugin_id: SSE_INGRESS, effects: ['transport'] }); }, 'semantic NodeSlot'],
    ['SSE compiled registration missing', (data) => { data.plan.transport_plugins.pop(); }, 'must exist exactly once'],
    ['SSE semantic effect', (data) => { data.plan.transport_plugins[0].effect = 'semantic'; }, 'registration drift'],
    ['SSE payload write', (data) => { data.plan.transport_plugins[0].writes = ['v4.response.normal_payload']; }, 'semantic payload'],
    ['SSE transport node missing', (data) => { data.nodeGraph.registered_nodes = []; }, 'compiled V4TransportSsePlugin'],
    ['SSE resource remains design', (data) => { data.resourceMap.resources[0].status = 'design'; }, 'not active'],
    ['stream disposition event missing', (data) => { data.resourceMap.resources.splice(1, 1); }, 'disposition event resource missing'],
    ['runtime-bin parses SSE event', (data) => { data.sources['runtime-bin'] = 'struct ResponsesSseStream {}\nfn x(){ decode_provider_sse_frame(b""); }\nfn project_fault() {}'; }, 'semantic codec'],
    ['runtime-bin owns terminal state', (data) => { data.sources['runtime-bin'] = 'struct ResponsesSseStream { terminal_seen: bool }\nfn project_fault() {}'; }, 'semantic stream state'],
    ['runtime duplicates SSE codec', (data) => { data.sources.runtime += '\npub fn parse_responses_sse_frame('; }, 'duplicates provider SSE codec'],
    ['runtime disposition removed', (data) => { data.sources.runtime = data.sources.runtime.replace('pub enum ResponseStreamDisposition', ''); }, 'runtime SSE response owner missing'],
    ['skeleton unknown-field guard removed', (data) => { data.sources.skeleton = data.sources.skeleton.replace('#[serde(deny_unknown_fields)]', ''); }, 'deny_unknown_fields'],
    ['runtime payload projection', (data) => { data.sources.runtime = 'project_chat_request_to_responses(&value)'; }, 'forbidden payload projection'],
    ['runtime local continuation', (data) => { data.sources.runtime = 'continuation_restore'; }, 'runtime-local continuation'],
    ['hook protocol payload inference', (data) => { data.sources.modelHooks = 'value.get("protocol")'; }, 'infers protocol'],
    ['Direct protocol fallback', (data) => { data.plan.direct_protocol_contract.mismatch = 'relay'; }, 'same-protocol'],
    ['client/provider coupling', (data) => { data.plan.protocol_information_contract.client_provider_independent = false; }, 'typed protocol independence'],
    ['SSE semantic parser', (data) => { data.sources.sseTransport += '\nuse serde_json::Value;'; }, 'reads semantic payload'],
    ['runtime-bin Direct container constructor', (data) => { data.sources['runtime-bin'] = 'DirectRelayContainer::new('; }, 'second Direct execution surface'],
    ['runtime-bin Direct request passthrough', (data) => { data.sources['runtime-bin'] = 'struct DirectRequestPassthrough;'; }, 'second Direct execution surface'],
    ['runtime-bin Direct response execution', (data) => { data.sources['runtime-bin'] = 'direct_relay.execute_response('; }, 'second Direct execution surface'],
    ['dedicated Direct container module', (data) => { data.sources.nodeContainer += '\npub mod direct_relay;'; }, 'dedicated DirectRelayContainer'],
    ['Direct function map old owner', (data) => {
      data.functionMap.functions
        .find((entry) => entry.function_id === 'v4.direct.relay_container')
        .owner = 'routecodex-v4-node-container';
    }, 'generic NodeContainer'],
    ['Direct mainline old execution surface', (data) => { data.mainlineMap.edges[0].path += ',crates/routecodex-v4-node-container/src/direct_relay.rs'; }, 'second Direct execution surface'],
    ['generic NodeContainer execution removed', (data) => { data.sources.nodeContainer = data.sources.nodeContainer.replace('pub fn execute_with_plan_hash', ''); }, 'generic NodeContainer execution surface missing'],
  ];
  for (const [name, mutate, expected] of cases) {
    const data = structuredClone(fixture());
    mutate(data);
    const failures = validate(data.plan, data.nodeGraph, data.functionMap, data.resourceMap, data.mainlineMap, data.verificationMap, data.sources);
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
    readJson('contracts/node-graph.contract.json'),
    readJson('docs/architecture/maps/function-map.json'),
    readJson('docs/architecture/maps/resource-map.json'),
    readJson('docs/architecture/maps/mainline-call-map.json'),
    readJson('docs/architecture/maps/verification-map.json'),
    {
      runtime: readText('crates/routecodex-v4-runtime/src/lib.rs'),
      'runtime-bin': readText('crates/routecodex-v4-runtime-bin/src/main.rs'),
      modelHooks: readText('crates/routecodex-v4-standard-plugins/src/model_hooks.rs'),
      sseTransport: readText('crates/routecodex-v4-standard-plugins/src/sse_transport.rs'),
      nodeContainer: readText('crates/routecodex-v4-node-container/src/lib.rs'),
      skeleton: readText('crates/routecodex-v4-skeleton/src/lib.rs'),
    },
  );
  if (failures.length > 0) {
    console.error('V4_DIRECT_RELAY_SSE_GATE_FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('V4_DIRECT_RELAY_SSE_GATE_OK');
}
