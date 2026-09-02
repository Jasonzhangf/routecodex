#!/usr/bin/env node
/**
 * v4_parity_gate_standard_plugins
 *
 * Locks the M5 standard plugin library truth:
 * 1. `contracts/plugin-library.contract.json` stays contract_bound with the
 *    category, immutable-registration, descriptor, side-channel, keyless and
 *    no-fallback rules intact.
 * 2. `routecodex-v4-standard-plugins` is registered in the module registry
 *    with owned_paths and the four M5 gates; the gates are registered in the
 *    verification map.
 * 3. The function map binds `v4.plugin.standard_library` to real declared
 *    Rust symbols in the crate source.
 * 4. The `.appsdk` resource `v4.plugin.standard_library` stays
 *    contract_bound with a contract owner (registered contract-bound plugin
 *    resource).
 * 5. Every standard-plugins Cargo path dependency is registered in the
 *    frozen-consumer-registry with mode source_path / status transitional,
 *    and no frozen-module path dependency exists (frozen modules are only
 *    consumed through the Active surface).
 * 6. The crate source exposes the typed handle registry, the eight category
 *    modules and the deterministic registration/compile surface, and carries
 *    no fallback / second-runtime / cross-node-dispatch / payload
 *    reconstruction / provider-specific hardcode tokens. Control handles use
 *    only resource-scoped ExecCtx access declared by their PlanEntry.
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = (file) => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const MODULE = 'routecodex-v4-standard-plugins';
const CRATE_SRC = path.join(root, 'crates', MODULE, 'src');

const CONTRACT_ID = 'v4-plugin-library';
const CONTRACT_RULES = [
  'categories_rule',
  'immutable_registration_rule',
  'descriptor_rule',
  'node_scoped_resource_rule',
  'side_channel_rule',
  'keyless_rule',
  'no_fallback_rule',
  'category_separation_rule',
];
const CONTRACT_SEMANTICS = [
  ['categories_rule', /contracts.*diagnostic.*control.*error.*protocol.*chat_process.*routing.*provider/],
  ['immutable_registration_rule', /immutable|idempotent/],
  ['descriptor_rule', /node_id.*role_id.*position/],
  ['node_scoped_resource_rule', /node.*cannot broaden permissions.*non-adjacent/],
  ['side_channel_rule', /never enter|side channel/],
  ['keyless_rule', /keyless|deterministic/],
  ['no_fallback_rule', /fallback|silent strip|second runtime|cross-node/],
  ['category_separation_rule', /never write/],
];

const GATES = [
  'v4_standard_plugins_l2_regression',
  'v4_standard_plugins_test_consumer',
  'v4_parity_gate_standard_plugins',
  'v4_parity_gate_standard_plugins_red',
];

const SOURCE_DEPS = [
  'routecodex-v4-plugin-contract',
  'routecodex-v4-plugin-catalog',
  'routecodex-v4-plugin-plan',
  'routecodex-v4-cordis-bridge',
  'routecodex-v4-node-container',
];

const REQUIRED_SOURCE = [
  'pub enum PluginCategory',
  'pub struct StandardPlugin',
  'pub struct StandardHandleRegistry',
  'impl HandleRegistry for StandardHandleRegistry',
  'pub fn standard_plugins',
  'pub fn standard_descriptors',
  'pub fn standard_resource_registry',
  'pub fn standard_node_allowed_reads',
  'pub fn standard_node_allowed_writes',
  'pub fn register_standard_library',
  'pub fn compile_standard_plan',
  'pub mod contracts',
  'pub mod diagnostic',
  'pub mod control',
  'pub mod error',
  'pub mod protocol',
  'pub mod chat_process',
  'pub mod routing',
  'pub mod provider;',
];

const NODE_PERMISSIONS = new Map([
  ['V4DirectReq01ClientProtocol', {
    reads: ['v4.direct.request.client_payload'], writes: [],
  }],
  ['V4DirectReq03ProviderWire', {
    reads: ['v4.direct.request.provider_wire'], writes: [],
  }],
  ['V4DirectResp01ProviderRaw', {
    reads: ['v4.direct.response.provider_raw'], writes: ['v4.direct.response.provider_raw'],
  }],
  ['V4DirectReq02RelayContainer', {
    reads: [
      'v4.direct.request.client_payload',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
      'v4.information.model',
      'v4.control.route_facts',
    ],
    writes: ['v4.direct.request.provider_wire', 'v4.control.target_selection'],
  }],
  ['V4DirectResp02RelayContainer', {
    reads: [
      'v4.direct.response.provider_raw',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
    ],
    writes: ['v4.direct.response.client_payload'],
  }],
  ['V4DirectResp03ClientProtocol', {
    reads: [
      'v4.direct.response.client_payload',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
      'v4.information.entry_protocol',
      'v4.information.stream_terminal',
    ],
    writes: [],
  }],
  ['V4ServerReqInbound01ClientRaw', {
    reads: ['v4.request.normal_payload'], writes: [],
  }],
  ['V4HubReqInbound02Normalized', {
    reads: ['v4.request.normal_payload'], writes: [],
  }],
  ['V4HubReqChatProcess03Governed', {
    reads: ['v4.request.normal_payload'], writes: ['v4.request.normal_payload'],
  }],
  ['V4HubRespInbound03Normalized', {
    reads: ['v4.response.provider_raw'], writes: ['v4.response.normal_payload'],
  }],
  ['V4ProviderRespCompat02ProviderCompat', {
    reads: [
      'v4.response.provider_raw',
      'v4.information.provider_protocol',
    ],
    writes: ['v4.response.provider_raw'],
  }],
  ['V4ProviderRespInbound01Raw', {
    reads: ['v4.response.provider_raw'], writes: ['v4.response.provider_raw'],
  }],
  ['V4HubRespChatProcess04Governed', {
    reads: ['v4.response.normal_payload'],
    writes: ['v4.response.normal_payload', 'v4.control.metadata_center'],
  }],
  ['V4HubRespOutbound05ClientSemantic', {
    reads: [
      'v4.response.normal_payload',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
    ],
    writes: ['v4.response.client_wire_payload'],
  }],
  ['V4HubReqOutbound06ProviderSemantic', {
    reads: [
      'v4.request.normal_payload',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
    ],
    writes: ['v4.request.provider_semantic'],
  }],
  ['V4ProviderReqCompat07ProviderCompat', {
    reads: [
      'v4.request.provider_semantic',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
    ], writes: ['v4.request.provider_wire_payload'],
  }],
  ['V4ProviderReqOutbound08WirePayload', {
    reads: [
      'v4.request.provider_semantic',
      'v4.request.provider_wire_payload',
      'v4.information.client_protocol',
      'v4.information.provider_protocol',
    ],
    writes: ['v4.request.provider_wire_payload'],
  }],
  ['V4ProviderReqOutbound09TransportRequest', {
    reads: [
      'v4.request.provider_wire_payload',
      'v4.config.manifest',
      'v4.secret.provider_auth_handle',
    ],
    writes: [],
  }],
  ['V4ServerRespOutbound06ClientFrame', {
    reads: [
      'v4.response.client_wire_payload',
      'v4.information.entry_protocol',
      'v4.information.stream_terminal',
    ],
    writes: ['v4.response.client_object'],
  }],
  ['V4MetadataCenter01ScopeRegistry', {
    reads: ['v4.control.metadata_center'], writes: ['v4.control.metadata_center'],
  }],
  ['V4PayloadCycleRegistry', {
    reads: ['v4.lifecycle.payload_cycle'], writes: ['v4.lifecycle.payload_cycle'],
  }],
  ['V4Error01SourceRaised', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4Error02HostCaptured', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4Error03RuntimeClassified', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4Error04RouterPolicyApplied', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4Error05ExecutionDecision', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4Error06ClientProjected', {
    reads: ['v4.control.error_chain'], writes: ['v4.control.error_chain'],
  }],
  ['V4HubReqExecution04Planned', {
    reads: ['v4.information.entry_protocol', 'v4.information.execution_lane', 'v4.control.route_facts'], writes: ['v4.control.route_facts'],
  }],
  ['V4HubReqTarget05Resolved', {
    reads: ['v4.control.route_facts', 'v4.control.target_selection', 'v4.information.model'], writes: ['v4.control.target_selection'],
  }],
  ['V4Router05RequestClassified', {
    reads: ['v4.control.route_facts'], writes: [],
  }],
  ['V4Router06SelectionPlan', {
    reads: ['v4.control.target_selection'], writes: [],
  }],
]);

const PLUGIN_DESCRIPTOR_RE = /plugin\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))\s*,\s*PluginCategory::[A-Za-z]+\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*Some\((\d+)\)\s*,[\s\S]*?vec!\[([^\]]*)\]\s*,\s*vec!\[([^\]]*)\]\s*,\s*\)/g;

function parseStringVector(source) {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function parseStandardDescriptors(source) {
  const constants = new Map(
    [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  );
  return [...source.matchAll(PLUGIN_DESCRIPTOR_RE)].map((match) => ({
    pluginId: match[1] ?? constants.get(match[2]) ?? `__unresolved:${match[2]}`,
    nodeId: match[3],
    roleId: match[4],
    position: Number(match[5]),
    reads: parseStringVector(match[6]),
    writes: parseStringVector(match[7]),
  }));
}

function functionBody(source, functionName) {
  const marker = `pub fn ${functionName}`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const opening = source.indexOf('{', start);
  if (opening < 0) return '';
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  return '';
}

function parseNodePermissionFunction(source, functionName) {
  const body = functionBody(source, functionName);
  const permissions = new Map();
  const armPattern = /((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>\s*(?:\{\s*(vec!\[[\s\S]*?\]|Vec::new\(\))\s*\}|(vec!\[[\s\S]*?\]|Vec::new\(\))\s*,)/g;
  for (const match of body.matchAll(armPattern)) {
    const nodeIds = [...match[1].matchAll(/"([^"]+)"/g)].map((node) => node[1]);
    const permissionSet = parseStringVector(match[2] ?? match[3]);
    for (const nodeId of nodeIds) {
      permissions.set(nodeId, permissionSet);
    }
  }
  return permissions;
}

function sameStrings(actual, expected) {
  return [...actual].sort().join('\n') === [...expected].sort().join('\n');
}

function activeNodeAnchors(nodeGraph) {
  const anchors = new Map();
  for (const node of nodeGraph.registered_nodes ?? []) {
    anchors.set(node.node_id, node);
  }
  for (const key of [
    'v4_direct_request_chain',
    'v4_direct_response_chain',
    'v4_hub_request_chain',
    'v4_hub_response_chain',
    'v4_config_chain',
    'v4_error_chain',
  ]) {
    for (const node of nodeGraph[key]?.nodes ?? []) {
      anchors.set(node.node_id, { ...(anchors.get(node.node_id) ?? {}), ...node });
    }
  }
  for (const chain of nodeGraph.chains ?? []) {
    for (const node of chain.nodes ?? []) {
      anchors.set(node.node_id, { ...(anchors.get(node.node_id) ?? {}), ...node });
    }
  }
  return anchors;
}

function actorPermitted(actors, nodeId, nodeOwner, resourceOwnerNode) {
  return nodeId === resourceOwnerNode || (actors ?? []).some((actor) => (
    actor === nodeId
    || actor.startsWith(`${nodeId}::`)
    || actor === nodeOwner
  ));
}

// No fallback, no second runtime/kernel, no cross-node dispatch, no payload
// reconstruction, no provider/client metadata leakage, no frozen-module path
// dependency, no provider-specific hardcode (family prefix dispatch).
const FORBIDDEN_SOURCE = [
  'fn fallback',
  'fn silent_strip',
  'next_node(',
  'fn payload_reconstruct',
  'use routecodex_v4_base_node',
  'use routecodex_v4_edge',
  'use routecodex_v4_control',
  'use routecodex_v4_error',
  'use routecodex_v4_node_container',
  'provider_family',
  'match provider_id',
];

// Only crate-level declarations bind a symbol: column-0 `pub [item]` and
// `pub use` re-exports. Impl methods bind as `Type::method`.
const DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|fn|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
const IMPL_RE = /^[\s]*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/gm;
const METHOD_RE = /^[\s]*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

function collectDeclaredSymbols(crate) {
  const crateRoot = path.join(root, 'crates', crate, 'src');
  const symbols = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(DECL_RE)) {
          if (match[2]) symbols.add(match[2]);
        }
        for (const implMatch of source.matchAll(IMPL_RE)) {
          const typeName = implMatch[1];
          let depth = 0;
          let index = implMatch.index + implMatch[0].length;
          while (index < source.length) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') {
              depth -= 1;
              if (depth < 0) break;
            }
            index += 1;
          }
          const block = source.slice(implMatch.index + implMatch[0].length, index);
          for (const method of block.matchAll(METHOD_RE)) {
            if (method[1]) symbols.add(`${typeName}::${method[1]}`);
          }
        }
      }
    }
  };
  if (fs.existsSync(crateRoot)) {
    walk(crateRoot);
  }
  return symbols;
}

function readSource() {
  if (!fs.existsSync(CRATE_SRC)) {
    return '';
  }
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        parts.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(CRATE_SRC);
  return parts.join('\n');
}

function validate(
  contracts,
  moduleRegistry,
  verificationMap,
  functionMap,
  resourceMap,
  registry,
  nodeGraph,
  resourceOperations,
  mainline,
  source,
) {
  const failures = [];
  const gateIds = new Set((verificationMap.gates ?? []).map((gate) => gate.gate_id));

  const contract = contracts[CONTRACT_ID];
  if (!contract) {
    failures.push(`${CONTRACT_ID}: missing contract`);
  } else {
    if (contract.status !== 'contract_bound') {
      failures.push(`${CONTRACT_ID}: status must be contract_bound (got ${contract.status})`);
    }
    for (const rule of CONTRACT_RULES) {
      if (contract[rule] === undefined) {
        failures.push(`${CONTRACT_ID}: missing rule ${rule}`);
      }
    }
    for (const [rule, pattern] of CONTRACT_SEMANTICS) {
      const value =
        typeof contract[rule] === 'string' ? contract[rule] : JSON.stringify(contract[rule] ?? '');
      if (!pattern.test(value)) {
        failures.push(`${CONTRACT_ID}: ${rule} lost required semantics (${value.slice(0, 80)})`);
      }
    }
  }

  const registryModules = new Map(
    (moduleRegistry.modules ?? []).map((module) => [module.module_id, module]),
  );
  const module = registryModules.get(MODULE);
  if (!module) {
    failures.push(`${MODULE}: not registered in module registry`);
  } else {
    if (!(module.owned_paths ?? []).includes(`crates/${MODULE}/**`)) {
      failures.push(`${MODULE}: missing owned_path crates/${MODULE}/**`);
    }
    for (const gate of GATES) {
      if (!(module.verification_gates ?? []).includes(gate)) {
        failures.push(`${MODULE}: missing verification gate ${gate}`);
      }
    }
  }
  for (const gate of GATES) {
    if (!gateIds.has(gate)) {
      failures.push(`${MODULE}: gate ${gate} not registered in verification-map`);
    }
  }

  const functions = functionMap.functions ?? [];
  const entry = functions.find((candidate) => candidate.function_id === 'v4.plugin.standard_library');
  if (!entry) {
    failures.push('v4.plugin.standard_library: missing function-map entry');
  } else {
    if (entry.owner !== MODULE) {
      failures.push(`v4.plugin.standard_library: owner must be ${MODULE} (got ${entry.owner})`);
    }
    const present = collectDeclaredSymbols(MODULE);
    for (const symbol of entry.entry_symbols ?? []) {
      if (!present.has(symbol)) {
        failures.push(`v4.plugin.standard_library: symbol ${symbol} not declared in ${MODULE} src`);
      }
    }
  }

  const resources = resourceMap.resources ?? [];
  const resource = resources.find((candidate) => candidate.resource_id === 'v4.plugin.standard_library');
  if (!resource) {
    failures.push('v4.plugin.standard_library: missing .appsdk resource-map entry');
  } else {
    if (resource.status !== 'contract_bound') {
      failures.push(`v4.plugin.standard_library: status must stay contract_bound (got ${resource.status})`);
    }
    if (!String(resource.owner ?? '').startsWith('contract:')) {
      failures.push('v4.plugin.standard_library: owner must be a contract-bound owner');
    }
  }

  const registeredEdges = new Set(
    (registry.consumers ?? []).map((consumer) => `${consumer.consumer}->${consumer.dependency}`),
  );
  const mainlineEdges = (mainline?.edges ?? []);
  const bridgeEdge = mainlineEdges.find(
    (edge) =>
      edge.from === MODULE
      && edge.to === 'routecodex-v4-cordis-bridge'
      && edge.owner === 'routecodex-v4-standard-plugins::StandardHandleRegistry'
      && edge.edge_type === 'typed_handle_execution'
      && edge.status === 'active',
  );
  if (!bridgeEdge) {
    failures.push(`${MODULE}: scoped bridge execution edge missing`);
  } else {
    for (const symbol of [
      'ExecCtx',
      'ExecCtx::read_control_resource',
      'ExecCtx::write_control_resource',
    ]) {
      if (!(bridgeEdge.symbols ?? []).includes(symbol)) {
        failures.push(`${MODULE}: bridge execution edge missing ${symbol}`);
      }
    }
  }
  const nodeContainerEdge = mainlineEdges.find(
    (edge) =>
      edge.from === MODULE &&
      edge.to === 'routecodex-v4-node-container',
  );
  if (nodeContainerEdge) {
    failures.push(`${MODULE}: test-only node-container dependency must not enter the mainline call map`);
  }
  for (const dependency of SOURCE_DEPS) {
    const edge = (registry.consumers ?? []).find(
      (consumer) => consumer.consumer === MODULE && consumer.dependency === dependency,
    );
    if (!edge) {
      failures.push(`frozen-consumer-registry: missing ${MODULE} -> ${dependency}`);
      continue;
    }
    if (edge.mode !== 'source_path' || edge.status !== 'transitional') {
      failures.push(
        `frozen-consumer-registry: ${MODULE} -> ${dependency} must be source_path/transitional (got ${edge.mode}/${edge.status})`,
      );
    }
    if (!registeredEdges.has(`${MODULE}->${dependency}`)) {
      failures.push(`frozen-consumer-registry: unregistered edge ${MODULE}->${dependency}`);
    }
  }

  if (source.length === 0) {
    failures.push(`${MODULE}: crate source missing`);
  } else {
    for (const token of REQUIRED_SOURCE) {
      if (!source.includes(token)) {
        failures.push(`${MODULE}: missing source token ${token}`);
      }
    }
    for (const token of FORBIDDEN_SOURCE) {
      if (source.includes(token)) {
        failures.push(`${MODULE}: forbidden source token ${token}`);
      }
    }
    for (const token of ['.read_control_resource(', '.write_control_resource(']) {
      if (!source.includes(token)) {
        failures.push(`${MODULE}: missing resource-scoped control access ${token}`);
      }
    }
    if (/\.read_control\s*\(\s*\)/.test(source)) {
      failures.push(`${MODULE}: broad control carrier read reintroduced`);
    }
    if (/\.write_control\s*\(/.test(source)) {
      failures.push(`${MODULE}: broad control carrier write reintroduced`);
    }

    const descriptors = parseStandardDescriptors(source);
    const activeDescriptors = descriptors.filter(
      (descriptor) => !descriptor.pluginId.startsWith('v4.std.test.'),
    );
    const testDescriptors = descriptors.filter(
      (descriptor) => descriptor.pluginId.startsWith('v4.std.test.'),
    );
    if (activeDescriptors.length !== 46) {
      failures.push(`${MODULE}: expected 46 active standard descriptors, got ${activeDescriptors.length}`);
    }
    if (!activeDescriptors.some(
      (descriptor) => descriptor.pluginId === 'v4.std.chat_process.tool_harvest',
    )) {
      failures.push(`${MODULE}: missing required response tool harvest descriptor`);
    }
    if (testDescriptors.length !== 0) {
      failures.push(`${MODULE}: unexpected test-only response descriptors`);
    }
    const anchors = activeNodeAnchors(nodeGraph);
    const operationsByResource = new Map(
      (resourceOperations.resources ?? []).map((resource) => [resource.resource_id, resource]),
    );
    const permissionSources = {
      reads: parseNodePermissionFunction(source, 'standard_node_allowed_reads'),
      writes: parseNodePermissionFunction(source, 'standard_node_allowed_writes'),
    };
    for (const [nodeId, expected] of NODE_PERMISSIONS) {
      for (const direction of ['reads', 'writes']) {
        const actual = permissionSources[direction].get(nodeId) ?? [];
        if (!sameStrings(actual, expected[direction])) {
          failures.push(
            `${MODULE}: ${nodeId} ${direction} permission drift `
              + `(got ${actual.join(',')}; expected ${expected[direction].join(',')})`,
          );
        }
      }
    }
    for (const direction of ['reads', 'writes']) {
      for (const nodeId of permissionSources[direction].keys()) {
        if (!NODE_PERMISSIONS.has(nodeId)) {
          failures.push(`${MODULE}: undeclared ${direction} permission node ${nodeId}`);
        }
      }
    }
    for (const descriptor of activeDescriptors) {
      const anchor = anchors.get(descriptor.nodeId);
      if (!anchor) {
        failures.push(`${descriptor.pluginId}: unknown active node ${descriptor.nodeId}`);
        continue;
      }
      if (anchor.role_id !== descriptor.roleId) {
        failures.push(
          `${descriptor.pluginId}: node ${descriptor.nodeId} role ${descriptor.roleId} != ${anchor.role_id}`,
        );
      }
      if (anchor.position !== descriptor.position) {
        failures.push(
          `${descriptor.pluginId}: node ${descriptor.nodeId} position ${descriptor.position} != ${anchor.position}`,
        );
      }
      const permissions = NODE_PERMISSIONS.get(descriptor.nodeId);
      if (!permissions) {
        failures.push(`${descriptor.pluginId}: node ${descriptor.nodeId} has no standard permission binding`);
        continue;
      }
      for (const resource of descriptor.reads) {
        if (!permissions.reads.includes(resource)) {
          failures.push(`${descriptor.pluginId}: unauthorized node-scoped read ${resource}`);
        }
        const operation = operationsByResource.get(resource);
        if (!operation) {
          failures.push(`${descriptor.pluginId}: resource operation missing ${resource}`);
        } else if (!actorPermitted(
          operation.allowed_readers,
          descriptor.nodeId,
          anchor.owner,
          operation.owner_node,
        )) {
          failures.push(
            `${descriptor.pluginId}: ${descriptor.nodeId} is not an allowed reader of ${resource}`,
          );
        }
      }
      for (const resource of descriptor.writes) {
        if (!permissions.writes.includes(resource)) {
          failures.push(`${descriptor.pluginId}: unauthorized node-scoped write ${resource}`);
        }
        const operation = operationsByResource.get(resource);
        if (!operation) {
          failures.push(`${descriptor.pluginId}: resource operation missing ${resource}`);
        } else if (!actorPermitted(
          operation.allowed_writers,
          descriptor.nodeId,
          anchor.owner,
          operation.owner_node,
        )) {
          failures.push(
            `${descriptor.pluginId}: ${descriptor.nodeId} is not an allowed writer of ${resource}`,
          );
        }
      }
    }
  }

  return failures;
}

function runSelfTest() {
  const contracts = { [CONTRACT_ID]: readJson('contracts/plugin-library.contract.json') };
  const moduleRegistry = readJson('.appsdk/maps/module-registry.json');
  const verificationMap = readJson('docs/architecture/maps/verification-map.json');
  const functionMap = readJson('docs/architecture/maps/function-map.json');
  const resourceMap = readJson('docs/architecture/maps/resource-map.json');
  const registry = readJson('contracts/active-link/frozen-consumer-registry.json');
  const nodeGraph = readJson('contracts/node-graph.contract.json');
  const resourceOperations = readYaml('docs/architecture/v4-resource-operation-map.yml');
  const mainline = readJson('docs/architecture/maps/mainline-call-map.json');
  const source = readSource();

  const cases = [
    ['contract status downgraded', (state) => {
      state.contracts[CONTRACT_ID].status = 'design';
    }],
    ['side-channel rule removed', (state) => {
      delete state.contracts[CONTRACT_ID].side_channel_rule;
    }],
    ['module registry entry missing', (state) => {
      state.moduleRegistry.modules = state.moduleRegistry.modules.filter(
        (module) => module.module_id !== MODULE,
      );
    }],
    ['verification gate unregistered', (state) => {
      state.verificationMap.gates = state.verificationMap.gates.filter(
        (gate) => gate.gate_id !== 'v4_parity_gate_standard_plugins',
      );
    }],
    ['function-map entry missing', (state) => {
      state.functionMap.functions = state.functionMap.functions.filter(
        (entry) => entry.function_id !== 'v4.plugin.standard_library',
      );
    }],
    ['function-map symbol missing', (state) => {
      const entry = state.functionMap.functions.find(
        (candidate) => candidate.function_id === 'v4.plugin.standard_library',
      );
      entry.entry_symbols = ['GhostSymbol'];
    }],
    ['plugin resource drifted to active', (state) => {
      const resource = state.resourceMap.resources.find(
        (candidate) => candidate.resource_id === 'v4.plugin.standard_library',
      );
      resource.status = 'active';
      resource.owner = `${MODULE}::StandardHandleRegistry`;
    }],
    ['source-path dependency deregistered', (state) => {
      state.registry.consumers = state.registry.consumers.filter(
        (consumer) => !(consumer.consumer === MODULE && consumer.dependency === 'routecodex-v4-plugin-catalog'),
      );
    }],
    ['forbidden import reintroduced', (state) => {
      state.source = `${source}\nuse routecodex_v4_base_node::BaseNode;`;
    }],
    ['category module removed', (state) => {
      state.source = source.replace('pub mod provider;', 'mod provider;');
    }],
    ['response tool harvest descriptor removed', (state) => {
      state.source = source.replace(
        '"v4.std.chat_process.tool_harvest",',
        '"v4.std.chat_process.tool_harvest.removed",',
      );
    }],
    ['fallback handler reintroduced', (state) => {
      state.source = `${source}\nfn fallback() {}`;
    }],
    ['broad control carrier access reintroduced', (state) => {
      state.source = `${source}\nfn broad(ctx: &ExecCtx<'_>) { let _ = ctx.read_control(); }`;
    }],
    ['scoped bridge symbol removed from mainline', (state) => {
      const edge = state.mainline.edges.find(
        (candidate) => candidate.from === MODULE
          && candidate.to === 'routecodex-v4-cordis-bridge',
      );
      edge.symbols = edge.symbols.filter(
        (symbol) => symbol !== 'ExecCtx::read_control_resource',
      );
    }],
    ['retired node selector reintroduced', (state) => {
      state.source = source.replace(
        '"V4ProviderReqOutbound08WirePayload",\n        "request_outbound",',
        '"V4ProviderReqCompat06Compat",\n        "request_outbound",',
      );
    }],
    ['active node role mismatch reintroduced', (state) => {
      state.source = source.replace(
        '"V4ProviderReqOutbound08WirePayload",\n        "request_outbound",',
        '"V4ProviderReqOutbound08WirePayload",\n        "request_chat_process",',
      );
    }],
    ['active node position mismatch reintroduced', (state) => {
      state.source = source.replace(
        '"V4ProviderReqOutbound08WirePayload",\n        "request_outbound",\n        Some(8),',
        '"V4ProviderReqOutbound08WirePayload",\n        "request_outbound",\n        Some(7),',
      );
    }],
    ['provider semantic reversal reintroduced', (state) => {
      state.source = source.replace(
        'vec!["v4.request.provider_semantic"],\n        vec!["v4.request.provider_wire_payload"],',
        'vec!["v4.request.provider_semantic"],\n        vec!["v4.request.normal_payload"],',
      );
    }],
    ['node permission broadened', (state) => {
      state.source = source.replace(
        '"V4ProviderReqCompat07ProviderCompat" | "V4ProviderReqOutbound08WirePayload" => {\n'
          + '            vec!["v4.request.provider_wire_payload".to_string()]\n'
          + '        }',
        '"V4ProviderReqCompat07ProviderCompat" | "V4ProviderReqOutbound08WirePayload" => {\n'
          + '            vec![\n'
          + '                "v4.request.provider_wire_payload".to_string(),\n'
          + '                "v4.request.normal_payload".to_string(),\n'
          + '            ]\n'
          + '        }',
      );
    }],
    ['provider response compat permission removed', (state) => {
      state.source = source.replace(
        '"V4ProviderRespCompat02ProviderCompat" => vec!["v4.response.provider_raw".to_string()],',
        '"V4ProviderRespCompat02ProviderCompat" => Vec::new(),',
      );
    }],
    ['resource operation owner and writer removed', (state) => {
      const resource = state.resourceOperations.resources.find(
        (candidate) => candidate.resource_id === 'v4.request.provider_semantic',
      );
      resource.owner_node = 'V4HubReqInbound03Normalized';
      resource.allowed_writers = [];
    }],
    ['production dependency on NodeContainer reintroduced', (state) => {
      state.source = `${source}\nuse routecodex_v4_node_container::NodeContainer;`;
    }],
    ['test-only edge reintroduced as active mainline', (state) => {
      state.mainline.edges.push({
        from: 'routecodex-v4-standard-plugins',
        to: 'routecodex-v4-node-container',
        owner: 'routecodex-v4-standard-plugins',
        edge_type: 'symbol_dependency',
        symbols: ['NodeContainer'],
        path: 'crates/routecodex-v4-standard-plugins/src/lib.rs',
        status: 'active',
      });
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const state = {
      contracts: clone(contracts),
      moduleRegistry: clone(moduleRegistry),
      verificationMap: clone(verificationMap),
      functionMap: clone(functionMap),
      resourceMap: clone(resourceMap),
      registry: clone(registry),
      nodeGraph: clone(nodeGraph),
      resourceOperations: clone(resourceOperations),
      mainline: clone(mainline),
      source: clone(source),
    };
    mutate(state);
    const failures = validate(
      state.contracts,
      state.moduleRegistry,
      state.verificationMap,
      state.functionMap,
      state.resourceMap,
      state.registry,
      state.nodeGraph,
      state.resourceOperations,
      state.mainline,
      state.source,
    );
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_standard_plugins] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_standard_plugins] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_standard_plugins] OK red self-test ${cases.length}/${cases.length}`);
}

const isRedSelfTest = process.argv.includes('--red-self-test');
if (isRedSelfTest) {
  runSelfTest();
} else {
  const failures = validate(
    { [CONTRACT_ID]: readJson('contracts/plugin-library.contract.json') },
    readJson('.appsdk/maps/module-registry.json'),
    readJson('docs/architecture/maps/verification-map.json'),
    readJson('docs/architecture/maps/function-map.json'),
    readJson('docs/architecture/maps/resource-map.json'),
    readJson('contracts/active-link/frozen-consumer-registry.json'),
    readJson('contracts/node-graph.contract.json'),
    readYaml('docs/architecture/v4-resource-operation-map.yml'),
    readJson('docs/architecture/maps/mainline-call-map.json'),
    readSource(),
  );
  if (failures.length > 0) {
    console.error('[v4_parity_gate_standard_plugins] FAIL');
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('[v4_parity_gate_standard_plugins] OK standard plugin library module bound');
}
