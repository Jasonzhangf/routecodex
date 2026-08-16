#!/usr/bin/env node
/**
 * v4_parity_gate_node_graph
 *
 * Phase 1 Node Graph machine lock (design V4-NODE-GRAPH-ACTIVE-20260816,
 * owner feature v4.node_graph). Locks the fixed four-chain topology and the
 * single node catalog shared by node-graph.contract.json, the compiled
 * skeleton plan, the 49/49 anchored resource map, and the mainline call map.
 *
 * Positive checks:
 *  1. node-graph.contract.json status=active with self-consistent graph_hash.
 *  2. Fixed chains: request 7 / response 6 / error 6 / config 5, exact IDs,
 *     positions 01..N, no gap/duplicate/reorder/temp numbering, role_id in
 *     the declared family role subclasses, group flag only on group nodes.
 *  3. registered_nodes: unique ids, every entry has node_id/family/role_id/
 *     scope/owner, family+role declared in standard_node_families.
 *  4. Every anchored resource owner_node and every node-like relation ref is
 *     in the machine catalog (chains + registered_nodes); no checkpoint
 *     circularity (checkpoints are consumers, not catalog truth).
 *  5. Skeleton plan: same node IDs/positions/edges as the graph, single
 *     terminal (last node), single kernel (first node), roles equal to the
 *     graph chain roles, checkpoints reference only catalog nodes.
 *  6. Parent chains never connect group-internal nodes.
 *  7. Mainline call map: request/response adjacent data_flow edges and config
 *     information_flow edges declared, all adjacent, resources on the right
 *     axis; no revived old 3-node IDs anywhere.
 *  8. graph_hash drift and old-ID revival are red.
 *
 * Run with --red-self-test to prove each negative class fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = (file) => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));

/** Normative fixed topology from V4-NODE-GRAPH-ACTIVE-20260816. */
const CHAIN_EXPECTED = {
  request: [
    'V4ServerReqInbound01ClientRaw',
    'V4ServerSseIn02FrameBoundary',
    'V4HubReqInbound03Normalized',
    'V4HubReqChatProcess04Governed',
    'V4HubReqOutbound05ProviderSemantic',
    'V4ProviderReqCompat06Compat',
    'V4ProviderSseOut07WireBoundary',
  ],
  response: [
    'V4ProviderSseIn01FrameBoundary',
    'V4HubRespInbound02Parsed',
    'V4HubRespChatProcess03Governed',
    'V4HubRespOutbound04ClientSemantic',
    'V4ServerSseOut05FrameBoundary',
    'V4ServerRespOutbound06ClientFrame',
  ],
  error: [
    'V4Error01SourceRaised',
    'V4Error02HostCaptured',
    'V4Error03RuntimeClassified',
    'V4Error04RouterPolicyApplied',
    'V4Error05ExecutionDecision',
    'V4Error06ClientProjected',
  ],
  config: [
    'V4Config01AuthoringFileSource',
    'V4Config02AuthoringParsed',
    'V4Config03SchemaValidated',
    'V4Config04ResourceRegistryBuilt',
    'V4Config05ManifestPublished',
  ],
};

const CHAIN_KEYS = {
  request: 'v4_hub_request_chain',
  response: 'v4_hub_response_chain',
  error: 'v4_error_chain',
  config: 'v4_config_chain',
};

const CHAIN_FAMILY = {
  request: 'RequestChainNode',
  response: 'ResponseChainNode',
  error: 'ErrorChainNode',
  config: 'ConfigChainNode',
};

const GROUP_NODES = new Set([
  'V4HubReqChatProcess04Governed',
  'V4HubRespChatProcess03Governed',
]);

/** Old compressed/legacy IDs that must never reappear after migration. */
const REVIVAL_DENYLIST = new Set([
  'V4ReqInbound01Raw',
  'V4ReqProcess02',
  'V4ReqOutbound03',
  'V4RespInbound01Raw',
  'V4RespProcess02',
  'V4ClientProjection03',
  'V4ReqInbound02Normalized',
  'V4ReqChatProcess03Governed',
  'V4ReqOutbound05ProviderSemantic',
  'V4ProviderReqOutbound06WirePayload',
  'V4ProviderTransport07Request',
  'V4ProviderRespInbound01Raw',
  'V4RespInbound02Parsed',
  'V4RespOutbound04ClientSemantic',
  'V4ServerRespOutbound05ClientFrame',
]);

const NODE_ID_RE = /^V4[A-Za-z0-9_]+$/;

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function canonicalGraphHash(nodeGraph) {
  const value = structuredClone(nodeGraph);
  delete value.graph_hash;
  const sha = (data) => createHash('sha256').update(data).digest('hex');
  return `sha256:${sha(canonicalJson(value))}`;
}

function roleCatalog(nodeGraph) {
  const families = new Map();
  for (const family of nodeGraph.standard_node_families ?? []) {
    const roles = new Set();
    for (const subclass of family.role_subclasses ?? []) {
      roles.add(subclass.role_id);
    }
    families.set(family.family, roles);
  }
  return families;
}

function validate(nodeGraph, resourceMap, skeleton, mainline) {
  const failures = [];
  const roleCatalogByFamily = roleCatalog(nodeGraph);
  const chainSections = {};
  const nodeCatalog = new Set();
  const registeredIds = new Set();

  // ---- 1. contract status + hash ----
  if (nodeGraph.status !== 'active') {
    failures.push(`node-graph status=${String(nodeGraph.status)} (must be active)`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(nodeGraph.graph_hash ?? ''))) {
    failures.push('node-graph missing/incorrect graph_hash (sha256:64hex)');
  } else if (nodeGraph.graph_hash !== canonicalGraphHash(nodeGraph)) {
    failures.push(`node-graph graph_hash drift (stored ${nodeGraph.graph_hash}, recomputed ${canonicalGraphHash(nodeGraph)})`);
  }

  // ---- 2. fixed chains ----
  for (const chainId of Object.keys(CHAIN_EXPECTED)) {
    const section = nodeGraph[CHAIN_KEYS[chainId]];
    chainSections[chainId] = section;
    if (!section || !Array.isArray(section.nodes)) {
      failures.push(`node-graph missing chain section ${CHAIN_KEYS[chainId]}`);
      continue;
    }
    const expected = CHAIN_EXPECTED[chainId];
    const nodes = section.nodes;
    if (nodes.length !== expected.length) {
      failures.push(`${chainId}: expected ${expected.length} nodes, got ${nodes.length}`);
    }
    const seen = new Set();
    const familyRoles = roleCatalogByFamily.get(CHAIN_FAMILY[chainId]) ?? new Set();
    nodes.forEach((node, index) => {
      const position = index + 1;
      const expectedId = expected[index];
      const numberSuffix = String(position).padStart(2, '0');
      if (!node || typeof node.node_id !== 'string') {
        failures.push(`${chainId}: node at position ${position} missing node_id`);
        return;
      }
      if (node.node_id !== expectedId) {
        failures.push(`${chainId}: position ${position} expected ${expectedId}, got ${node.node_id}`);
      }
      if (!node.node_id.endsWith(numberSuffix) || /[.][0-9]/.test(node.node_id)) {
        failures.push(`${chainId}: node ${node.node_id} violates position numbering ${numberSuffix} (no temp numbering)`);
      }
      if (seen.has(node.node_id)) {
        failures.push(`${chainId}: duplicate node ${node.node_id}`);
      }
      seen.add(node.node_id);
      if (node.position !== position) {
        failures.push(`${chainId}: node ${node.node_id} position=${node.position} (must be ${position})`);
      }
      if (!familyRoles.has(node.role_id)) {
        failures.push(`${chainId}: node ${node.node_id} role ${node.role_id} not declared for family ${CHAIN_FAMILY[chainId]}`);
      }
      const isGroup = node.group === true;
      if (isGroup !== GROUP_NODES.has(node.node_id)) {
        failures.push(`${chainId}: node ${node.node_id} group flag mismatch`);
      }
      nodeCatalog.add(node.node_id);
    });
    if (nodes.length === expected.length) {
      for (let i = 0; i < expected.length; i += 1) {
        nodeCatalog.add(expected[i]);
      }
    }
  }

  // ---- 3. registered_nodes ----
  const registered = nodeGraph.registered_nodes ?? [];
  const seenRegistered = new Set();
  for (const node of registered) {
    if (!node || !NODE_ID_RE.test(String(node.node_id ?? ''))) {
      failures.push('registered node with invalid/empty node_id');
      continue;
    }
    if (seenRegistered.has(node.node_id)) {
      failures.push(`registered node duplicate ${node.node_id}`);
    }
    seenRegistered.add(node.node_id);
    registeredIds.add(node.node_id);
    for (const field of ['family', 'role_id', 'scope', 'owner']) {
      if (!String(node[field] ?? '').trim()) {
        failures.push(`registered node ${node.node_id}: missing ${field}`);
      }
    }
    const familyRoles = roleCatalogByFamily.get(node.family);
    if (!familyRoles) {
      failures.push(`registered node ${node.node_id}: unknown family ${node.family}`);
    } else if (!familyRoles.has(node.role_id)) {
      failures.push(`registered node ${node.node_id}: role ${node.role_id} not declared for family ${node.family}`);
    }
    nodeCatalog.add(node.node_id);
  }

  // ---- 4. anchored resource coverage ----
  const resById = new Map();
  for (const resource of resourceMap.resources ?? []) {
    resById.set(resource.resource_id, resource);
    if (resource.binding_status !== 'anchored') continue;
    if (!nodeCatalog.has(resource.owner_node)) {
      failures.push(`anchored resource ${resource.resource_id}: owner_node ${resource.owner_node} not registered in node catalog`);
    }
    for (const kind of ['allowed_writers', 'allowed_readers', 'forbidden_writers']) {
      for (const ref of resource[kind] ?? []) {
        const base = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(ref)?.[1];
        if (base && !nodeCatalog.has(base)) {
          failures.push(`anchored resource ${resource.resource_id}: ${kind} ref ${ref} not registered in node catalog`);
        }
      }
    }
  }

  // ---- 5. skeleton plan binding ----
  const skeletonByChain = new Map(
    (skeleton.chains ?? []).map((chain) => [chain.chain_id, chain]),
  );
  const graphRoleById = new Map();
  for (const chainId of Object.keys(CHAIN_EXPECTED)) {
    for (const node of chainSections[chainId]?.nodes ?? []) {
      graphRoleById.set(node.node_id, node.role_id);
    }
  }
  for (const chainId of Object.keys(CHAIN_EXPECTED)) {
    const planChain = skeletonByChain.get(chainId);
    if (!planChain) {
      failures.push(`skeleton missing chain ${chainId}`);
      continue;
    }
    const expected = CHAIN_EXPECTED[chainId];
    const nodeIds = (planChain.nodes ?? []).map((node) => node.node_id);
    if (JSON.stringify(nodeIds) !== JSON.stringify(expected)) {
      failures.push(`skeleton ${chainId}: nodes ${JSON.stringify(nodeIds)} != expected ${JSON.stringify(expected)}`);
    }
    const terminals = (planChain.nodes ?? []).filter((node) => node.terminal === true);
    const kernels = (planChain.nodes ?? []).filter((node) => node.kernel === true);
    if (terminals.length !== 1 || terminals[0]?.node_id !== expected[expected.length - 1]) {
      failures.push(`skeleton ${chainId}: single terminal must be ${expected[expected.length - 1]}`);
    }
    if (kernels.length !== 1 || kernels[0]?.node_id !== expected[0]) {
      failures.push(`skeleton ${chainId}: single kernel must be ${expected[0]}`);
    }
    const byId = new Map((planChain.nodes ?? []).map((node) => [node.node_id, node]));
    for (const node of planChain.nodes ?? []) {
      const graphRole = graphRoleById.get(node.node_id);
      if (graphRole && node.role_id !== graphRole) {
        failures.push(`skeleton ${chainId}: node ${node.node_id} role ${node.role_id} != graph role ${graphRole}`);
      }
      if (REVIVAL_DENYLIST.has(node.node_id)) {
        failures.push(`skeleton ${chainId}: revived legacy node ${node.node_id}`);
      }
    }
    const expectedEdges = expected.slice(0, -1).map((id, index) => [id, expected[index + 1]]);
    const actualEdges = (planChain.edges ?? []).map((edge) => [edge.from, edge.to]);
    const expectedSet = new Set(expectedEdges.map(([a, b]) => `${a}->${b}`));
    const actualSet = new Set(actualEdges.map(([a, b]) => `${a}->${b}`));
    if (JSON.stringify([...actualSet].sort()) !== JSON.stringify([...expectedSet].sort())) {
      failures.push(`skeleton ${chainId}: edges ${JSON.stringify([...actualSet].sort())} != expected adjacent ${JSON.stringify([...expectedSet].sort())}`);
    }
    for (const edge of planChain.edges ?? []) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) {
        failures.push(`skeleton ${chainId}: edge references unknown node ${edge.from}->${edge.to}`);
      }
    }
    for (const checkpoint of planChain.checkpoints ?? []) {
      if (REVIVAL_DENYLIST.has(checkpoint.node_id)) {
        failures.push(`skeleton ${chainId}: checkpoint references legacy node ${checkpoint.node_id}`);
      }
      if (!nodeCatalog.has(checkpoint.node_id) && !registeredIds.has(checkpoint.node_id)) {
        failures.push(`skeleton ${chainId}: checkpoint references unregistered node ${checkpoint.node_id}`);
      }
      if (expected.includes(checkpoint.node_id) && !expectedIdsForChain(chainId, expected).includes(checkpoint.node_id)) {
        failures.push(`skeleton ${chainId}: checkpoint ${checkpoint.node_id} chain mismatch`);
      }
    }
  }

  // ---- 6. group-internal parent edges ----
  const groupInternal = new Set(
    registered
      .filter((node) => String(node.scope ?? '').includes('group_private') || node.group_internal === true)
      .map((node) => node.node_id),
  );
  for (const chain of skeleton.chains ?? []) {
    for (const edge of chain.edges ?? []) {
      if (groupInternal.has(edge.from) || groupInternal.has(edge.to)) {
        failures.push(`skeleton ${chain.chain_id}: parent chain connects group-internal node (${edge.from}->${edge.to})`);
      }
    }
  }

  // ---- 7. mainline binding ----
  const mainlineEdges = (mainline.edges ?? []).filter((edge) => {
    const from = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(edge.from ?? '')?.[1];
    const to = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(edge.to ?? '')?.[1];
    return from || to;
  });
  for (const edge of mainlineEdges) {
    const from = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(edge.from ?? '')?.[1];
    const to = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(edge.to ?? '')?.[1];
    if (!from || !to) {
      failures.push(`mainline node edge missing endpoints (${edge.from ?? ''}->${edge.to ?? ''})`);
      continue;
    }
    if (REVIVAL_DENYLIST.has(from) || REVIVAL_DENYLIST.has(to)) {
      failures.push(`mainline edge revives legacy node (${from}->${to})`);
    }
    if (!nodeCatalog.has(from) || !nodeCatalog.has(to)) {
      failures.push(`mainline edge references unregistered node (${from}->${to})`);
    }
  }
  for (const chainId of ['request', 'response', 'config']) {
    const expected = CHAIN_EXPECTED[chainId];
    const expectedEdgeType = chainId === 'config' ? 'information_flow' : 'data_flow';
    for (let i = 0; i < expected.length - 1; i += 1) {
      const edge = mainlineEdges.find((candidate) => {
        const from = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(candidate.from ?? '')?.[1];
        const to = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(candidate.to ?? '')?.[1];
        return from === expected[i] && to === expected[i + 1];
      });
      if (!edge) {
        failures.push(`mainline missing ${chainId} adjacent edge ${expected[i]}->${expected[i + 1]}`);
        continue;
      }
      if (edge.edge_type !== expectedEdgeType) {
        failures.push(`mainline edge ${expected[i]}->${expected[i + 1]} type ${edge.edge_type} (must be ${expectedEdgeType})`);
      }
      const resource = resById.get(edge.resource);
      if (resource) {
        const expectedAxis = chainId === 'config' ? 'information' : 'data';
        if (resource.axis !== expectedAxis) {
          failures.push(`mainline edge ${expected[i]}->${expected[i + 1]} resource ${edge.resource} axis ${resource.axis} (must be ${expectedAxis})`);
        }
      }
    }
  }
  return failures;
}

function expectedIdsForChain(chainId, expected) {
  return expected;
}

function loadCurrent() {
  return {
    nodeGraph: readJson('contracts/node-graph.contract.json'),
    resourceMap: readYaml('docs/architecture/v4-resource-operation-map.yml'),
    skeleton: readJson('contracts/skeleton-plan.contract.json'),
    mainline: readJson('.appsdk/maps/mainline-call-map.json'),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCleanBase() {
  const expectedChains = {};
  for (const chainId of Object.keys(CHAIN_EXPECTED)) {
    expectedChains[chainId] = {
      chain_version: chainId === 'config' ? 'v4-config-1' : chainId === 'error' ? 'v4-error-1' : 'v4-hub-1',
      nodes: CHAIN_EXPECTED[chainId].map((nodeId, index) => ({
        position: index + 1,
        node_id: nodeId,
        role_id: chainRole(chainId, index),
        data_plane: chainId === 'config' ? 'information' : 'data',
        group: GROUP_NODES.has(nodeId) ? true : undefined,
      })),
    };
  }
  const families = [
    {
      family: 'RequestChainNode',
      role_subclasses: [
        { role_id: 'request_inbound' },
        { role_id: 'request_chat_process' },
        { role_id: 'request_execution' },
        { role_id: 'request_outbound' },
      ],
    },
    {
      family: 'ResponseChainNode',
      role_subclasses: [
        { role_id: 'response_inbound' },
        { role_id: 'response_chat_process' },
        { role_id: 'response_outbound' },
      ],
    },
    {
      family: 'ErrorChainNode',
      role_subclasses: [
        { role_id: 'error_source' },
        { role_id: 'error_classify' },
        { role_id: 'error_policy' },
        { role_id: 'error_decision' },
        { role_id: 'error_projection' },
      ],
    },
    {
      family: 'ConfigChainNode',
      role_subclasses: [
        { role_id: 'config_authoring' },
        { role_id: 'config_registry' },
        { role_id: 'config_manifest' },
      ],
    },
    {
      family: 'ControlCenterNode',
      role_subclasses: [{ role_id: 'control_center' }],
    },
    {
      family: 'DiagnosticChainNode',
      role_subclasses: [{ role_id: 'diagnostic_ledger' }],
    },
  ];
  const nodeGraph = {
    schema_version: 1,
    contract_id: 'v4-node-graph',
    status: 'active',
    owner_feature_id: 'v4.node_graph',
    standard_node_families: families,
    graph_hash: 'sha256:placeholder',
    [CHAIN_KEYS.request]: expectedChains.request,
    [CHAIN_KEYS.response]: expectedChains.response,
    [CHAIN_KEYS.error]: expectedChains.error,
    [CHAIN_KEYS.config]: expectedChains.config,
    registered_nodes: [
      {
        node_id: 'V4HubReqChatProcess04GroupPrivate',
        family: 'RequestChainNode',
        role_id: 'request_chat_process',
        scope: 'group_private',
        owner: 'routecodex-v4-runtime',
      },
      {
        node_id: 'V4ScopeRegistry',
        family: 'ControlCenterNode',
        role_id: 'control_center',
        scope: 'scope registry',
        owner: 'routecodex-v4-control',
      },
    ],
  };
  nodeGraph.graph_hash = canonicalGraphHash(nodeGraph);
  const skeleton = {
    schema_version: 1,
    contract_id: 'v4-skeleton-plan',
    status: 'active',
    owner_feature_id: 'v4.skeleton',
    skeleton_version: 'v4-skeleton-1',
    binding: { required: true, fields: ['skeleton_version', 'manifest_hash', 'plan_epoch', 'plan_hash'] },
    manifest_hash: 'sha256:test',
    plan_epoch: 1,
    plan_hash: 'sha256:test',
    chains: Object.keys(CHAIN_EXPECTED).map((chainId) => {
      const expected = CHAIN_EXPECTED[chainId];
      return {
        chain_id: chainId,
        nodes: expected.map((nodeId, index) => ({
          node_id: nodeId,
          chain: chainId,
          position: index + 1,
          role_id: chainRole(chainId, index),
          terminal: index === expected.length - 1,
          kernel: index === 0,
          plugins: [],
        })),
        edges: expected.slice(0, -1).map((nodeId, index) => ({
          from: nodeId,
          to: expected[index + 1],
          direction: 'forward',
        })),
        checkpoints: expected.map((nodeId) => ({
          node_id: nodeId,
          semantic: 'test',
          owner: 'test',
        })),
      };
    }),
  };
  const resourceMap = {
    resources: [
      {
        resource_id: 'v4.test.data',
        axis: 'data',
        binding_status: 'anchored',
        owner_node: 'V4HubReqInbound03Normalized',
        owner_crate: 'routecodex-v4-runtime',
        owner_symbols: ['test'],
        allowed_writers: ['V4HubReqInbound03Normalized'],
        allowed_readers: ['V4HubReqChatProcess04Governed'],
        forbidden_writers: ['V4ScopeRegistry'],
        verification_gate: ['v4_parity_gate_node_graph'],
      },
    ],
  };
  const mainline = {
    edges: [],
  };
  for (const chainId of ['request', 'response']) {
    const expected = CHAIN_EXPECTED[chainId];
    for (let i = 0; i < expected.length - 1; i += 1) {
      mainline.edges.push({
        from: expected[i],
        to: expected[i + 1],
        owner: 'routecodex-v4-runtime::SkeletonRuntime',
        edge_type: 'data_flow',
        resource: 'v4.test.data',
        path: 'crates/routecodex-v4-runtime/src/lib.rs',
        status: 'active',
      });
    }
  }
  const configExpected = CHAIN_EXPECTED.config;
  for (let i = 0; i < configExpected.length - 1; i += 1) {
    mainline.edges.push({
      from: configExpected[i],
      to: configExpected[i + 1],
      owner: 'routecodex-v4-config::parse_v4_config_02_from_v4_config_01',
      edge_type: 'information_flow',
      resource: 'v4.test.data',
      path: 'crates/routecodex-v4-config/src/lib.rs',
      status: 'active',
    });
  }
  return { nodeGraph, resourceMap, skeleton, mainline };
}

function chainRole(chainId, index) {
  const requestRoles = [
    'request_inbound',
    'request_inbound',
    'request_inbound',
    'request_chat_process',
    'request_outbound',
    'request_outbound',
    'request_outbound',
  ];
  const responseRoles = [
    'response_inbound',
    'response_inbound',
    'response_chat_process',
    'response_outbound',
    'response_outbound',
    'response_outbound',
  ];
  const errorRoles = ['error_source', 'error_source', 'error_classify', 'error_policy', 'error_decision', 'error_projection'];
  const configRoles = ['config_authoring', 'config_authoring', 'config_authoring', 'config_registry', 'config_manifest'];
  const map = { request: requestRoles, response: responseRoles, error: errorRoles, config: configRoles };
  return map[chainId][index];
}

function runSelfTest() {
  const cases = [];
  const add = (name, mutate, marker) => cases.push([name, mutate, marker]);
  add('status design', (d) => { d.nodeGraph.status = 'design'; }, 'must be active');
  add('graph_hash missing', (d) => { delete d.nodeGraph.graph_hash; }, 'graph_hash');
  add('graph_hash drift', (d) => { d.nodeGraph.graph_hash = 'sha256:' + '0'.repeat(64); }, 'drift');
  add('error chain section missing', (d) => { delete d.nodeGraph.v4_error_chain; }, 'missing chain section');
  add('request node missing', (d) => {
    d.nodeGraph.v4_hub_request_chain.nodes = d.nodeGraph.v4_hub_request_chain.nodes.slice(0, -1);
  }, 'expected 7 nodes');
  add('request duplicate node', (d) => {
    d.nodeGraph.v4_hub_request_chain.nodes = [...d.nodeGraph.v4_hub_request_chain.nodes, d.nodeGraph.v4_hub_request_chain.nodes[3]];
  }, 'duplicate');
  add('request reordered', (d) => {
    const nodes = d.nodeGraph.v4_hub_request_chain.nodes;
    [nodes[1], nodes[2]] = [nodes[2], nodes[1]];
  }, 'expected V4ServerSseIn02FrameBoundary');
  add('temp numbering', (d) => {
    d.nodeGraph.v4_hub_request_chain.nodes[3].node_id = 'V4HubReqChatProcess04.1Governed';
  }, 'temp numbering');
  add('registered duplicate', (d) => {
    d.nodeGraph.registered_nodes.push({ ...d.nodeGraph.registered_nodes[1] });
  }, 'registered node duplicate');
  add('registered unknown family', (d) => {
    d.nodeGraph.registered_nodes[1].family = 'GhostFamily';
  }, 'unknown family');
  add('registered missing owner', (d) => {
    delete d.nodeGraph.registered_nodes[1].owner;
  }, 'missing owner');
  add('registered unknown role', (d) => {
    d.nodeGraph.registered_nodes[1].role_id = 'ghost_role';
  }, 'not declared for family');
  add('anchored owner_node not registered', (d) => {
    d.resourceMap.resources[0].owner_node = 'V4GhostNode99';
  }, 'not registered in node catalog');
  add('skeleton old 3-node request', (d) => {
    d.skeleton.chains = d.skeleton.chains.map((chain) =>
      chain.chain_id === 'request'
        ? {
            ...chain,
            nodes: [
              { node_id: 'V4ReqInbound01Raw', chain: 'request', position: 1, role_id: 'request_inbound', terminal: false, kernel: true, plugins: [] },
              { node_id: 'V4ReqProcess02', chain: 'request', position: 2, role_id: 'request_chat_process', terminal: false, kernel: false, plugins: [] },
              { node_id: 'V4ReqOutbound03', chain: 'request', position: 3, role_id: 'request_outbound', terminal: true, kernel: false, plugins: [] },
            ],
            edges: [
              { from: 'V4ReqInbound01Raw', to: 'V4ReqProcess02', direction: 'forward' },
              { from: 'V4ReqProcess02', to: 'V4ReqOutbound03', direction: 'forward' },
            ],
          }
        : chain,
    );
  }, 'nodes ');
  add('skeleton extra edge', (d) => {
    const chain = d.skeleton.chains.find((c) => c.chain_id === 'request');
    chain.edges.push({ from: 'V4ServerReqInbound01ClientRaw', to: 'V4HubReqInbound03Normalized', direction: 'forward' });
  }, 'edges');
  add('checkpoint unregistered node', (d) => {
    d.skeleton.chains[0].checkpoints.push({ node_id: 'V4GhostCheckpoint', semantic: 'x', owner: 'x' });
  }, 'unregistered node');
  add('checkpoint legacy node', (d) => {
    d.skeleton.chains[0].checkpoints.push({ node_id: 'V4ReqInbound02Normalized', semantic: 'x', owner: 'x' });
  }, 'legacy node');
  add('mainline legacy edge', (d) => {
    d.mainline.edges.push({ from: 'V4ReqInbound01Raw', to: 'V4ReqProcess02', owner: 'x', edge_type: 'data_flow', resource: 'v4.test.data', path: 'x', status: 'active' });
  }, 'revives legacy node');
  add('mainline wrong edge type', (d) => {
    d.mainline.edges[0].edge_type = 'information_flow';
  }, 'must be data_flow');
  add('config role drift', (d) => {
    const chain = d.skeleton.chains.find((c) => c.chain_id === 'config');
    chain.nodes[2].role_id = 'config_registry';
  }, '!= graph role');
  add('group-internal parent edge', (d) => {
    const chain = d.skeleton.chains.find((c) => c.chain_id === 'request');
    chain.edges.push({ from: 'V4HubReqInbound03Normalized', to: 'V4HubReqChatProcess04GroupPrivate', direction: 'forward' });
  }, 'group-internal node');
  add('mainline missing adjacent edge', (d) => {
    d.mainline.edges = d.mainline.edges.filter(
      (edge) => !(edge.from === 'V4ServerReqInbound01ClientRaw' && edge.to === 'V4ServerSseIn02FrameBoundary'),
    );
  }, 'missing request adjacent edge');

  let failed = 0;
  for (const [name, mutate, marker] of cases) {
    const data = makeCleanBase();
    mutate(data);
    const failures = validate(data.nodeGraph, data.resourceMap, data.skeleton, data.mainline);
    const hit = failures.some((failure) => failure.includes(marker));
    if (failures.length === 0 || !hit) {
      console.error(`[v4_parity_gate_node_graph] red self-test ${name}: expected FAIL, got ${failures.length} failures (marker ${marker})`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_node_graph] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_node_graph] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const current = loadCurrent();
const failures = validate(current.nodeGraph, current.resourceMap, current.skeleton, current.mainline);
if (failures.length > 0) {
  console.error('[v4_parity_gate_node_graph] FAIL');
  console.error(failures.slice(0, 200).join('\n'));
  console.error(`... (${failures.length} total)`);
  process.exit(1);
}
console.log('[v4_parity_gate_node_graph] OK fixed 7/6/6/5 topology, registered catalog, skeleton/mainline/resource binding locked');
