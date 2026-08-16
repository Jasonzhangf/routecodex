#!/usr/bin/env node
/**
 * v4_compat_gate_relay_continuation
 *
 * Locks the V4 Relay + Continuation compatibility evidence slice:
 * 1. All six required surfaces are present (request path / response path /
 *    error path / streaming / lifecycle / audit) with no duplicate v3_stage
 *    per surface and no extra surfaces.
 * 2. Every entry maps V3 stage -> V4 container + checkpoint + resource +
 *    verification gate with non-empty evidence; diff_status=unexplained is RED
 *    and unexplained_diff must be 0.
 * 3. Referenced v4 resources / v4 checkpoints / verification gates exist in
 *    the machine truth (resource map, node graph + skeleton plan, verification
 *    map); v3_resource exists in the V3 resource map.
 * 4. Continuation contract lock: save only at V4HubRespChatProcess03Governed,
 *    immutable interval semantics forbidden, typed-facts selection vocabulary
 *    (entry_protocol / provider_wire_protocol / continuation_owner /
 *    execution_mode) and forbidden facts (provider_id / model_prefix /
 *    payload_shape_guess).
 * 5. Skeleton wiring lock: continuation plugins bind only to chat process
 *    nodes (request continuation_restore/classify; response continuation
 *    commit/release); inbound/outbound/server nodes never carry continuation
 *    semantics.
 * 6. Control-leak guard exists in the runtime wire/frame builders.
 *
 * Run with --red-self-test to prove the gate fails on each negative class
 * (compat drift + immutable interval + isolation + control-field-in-body).
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { loadV3Baseline } from './_v3-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (file) => {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};
const readYaml = (file) => {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  return yaml.load(fs.readFileSync(full, 'utf8'));
};
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const REQUIRED_SURFACES = ['request_path', 'response_path', 'error_path', 'streaming', 'lifecycle', 'audit'];
const CONTINUATION_PLUGINS = new Set(['continuation_classify', 'continuation_restore', 'continuation_commit', 'continuation_release']);
const SELECTION_FACTS = ['entry_protocol', 'provider_wire_protocol', 'continuation_owner', 'execution_mode'];
const FORBIDDEN_SELECTION_FACTS = ['provider_id', 'model_prefix', 'payload_shape_guess'];

function validate(slice, verification, resourceMap, v3ResourceMap, nodeGraph, skeletonPlan, runtimeSource) {
  const failures = [];

  const gateIds = new Set((verification.gates ?? []).map((gate) => gate.gate_id));
  const resourceIds = new Set((resourceMap.resources ?? []).map((resource) => resource.resource_id));
  const v3ResourceIds = new Set((v3ResourceMap.resources ?? []).map((resource) => resource.resource_id));

  const nodeIds = new Set();
  for (const chainKey of ['v4_hub_request_chain', 'v4_hub_response_chain', 'v4_config_chain']) {
    for (const node of nodeGraph[chainKey]?.nodes ?? []) {
      if (node.node_id) nodeIds.add(node.node_id);
    }
  }
  for (const chain of skeletonPlan.chains ?? []) {
    for (const checkpoint of chain.checkpoints ?? []) {
      if (checkpoint.node_id) nodeIds.add(checkpoint.node_id);
    }
  }
  // Registered side-chain/control-center nodes are the only additional node
  // catalog. Resource-map owner_node strings are never node evidence (a
  // resource cannot declare its own owning node, that would be circular).
  for (const node of nodeGraph.registered_nodes ?? []) {
    if (node.node_id) nodeIds.add(node.node_id);
  }

  const surfaces = slice.surfaces ?? [];
  const present = new Set(surfaces.map((surface) => surface.surface_id));
  for (const surfaceId of REQUIRED_SURFACES) {
    if (!present.has(surfaceId)) {
      failures.push(`relay-continuation slice: missing required surface ${surfaceId}`);
    }
  }
  for (const surface of surfaces) {
    if (!REQUIRED_SURFACES.includes(surface.surface_id)) {
      failures.push(`relay-continuation slice: extra surface ${surface.surface_id}`);
    }
  }

  let unexplained = 0;
  let entryTotal = 0;
  for (const surface of surfaces) {
    const seen = new Set();
    for (const entry of surface.entries ?? []) {
      entryTotal += 1;
      const id = `${surface.surface_id}.${entry.v3_stage ?? '?'}`;
      if (!entry.v3_stage) {
        failures.push(`${id}: missing v3_stage`);
      } else if (seen.has(entry.v3_stage)) {
        failures.push(`${id}: duplicate v3_stage in surface ${surface.surface_id}`);
      } else {
        seen.add(entry.v3_stage);
      }
      if (!entry.v3_resource) {
        failures.push(`${id}: missing v3_resource`);
      } else if (!v3ResourceIds.has(entry.v3_resource)) {
        failures.push(`${id}: v3_resource ${entry.v3_resource} not in v3-resource-operation-map.yml`);
      }
      if (!entry.v4_container?.family || !entry.v4_container?.role) {
        failures.push(`${id}: v4 container must have family + role`);
      }
      if (!entry.v4_checkpoint?.node_id || !entry.v4_checkpoint?.semantic) {
        failures.push(`${id}: v4 checkpoint must have node_id + semantic`);
      } else if (!nodeIds.has(entry.v4_checkpoint.node_id)) {
        failures.push(`${id}: v4 checkpoint node ${entry.v4_checkpoint.node_id} not in node-graph/skeleton/registered nodes`);
      }
      if (!entry.v4_resource) {
        failures.push(`${id}: missing v4_resource`);
      } else if (!resourceIds.has(entry.v4_resource)) {
        failures.push(`${id}: v4_resource ${entry.v4_resource} not in v4-resource-operation-map.yml`);
      }
      if (!Array.isArray(entry.verification_gates) || entry.verification_gates.length === 0) {
        failures.push(`${id}: missing verification gates`);
      } else {
        for (const gate of entry.verification_gates) {
          if (!gateIds.has(gate)) {
            failures.push(`${id}: verification gate ${gate} not in verification-map.json`);
          }
        }
      }
      const evidence = entry.evidence ?? '';
      if (!evidence || evidence === 'pending_skeleton_vslice') {
        failures.push(`${id}: evidence pending (${evidence || 'empty'})`);
      }
      if (entry.diff_status === 'unexplained') {
        unexplained += 1;
      } else if (!entry.diff_status) {
        failures.push(`${id}: missing diff_status`);
      }
    }
  }
  if (slice.unexplained_diff !== 0 || unexplained !== 0) {
    failures.push(
      `relay-continuation slice: unexplained_diff must be 0 (declared=${slice.unexplained_diff} actual=${unexplained})`,
    );
  }

  // Continuation contract lock.
  const respSemantics = nodeGraph.v4_hub_response_chain?.semantics ?? {};
  if (respSemantics.continuation_save_only_at !== 'V4HubRespChatProcess03Governed') {
    failures.push(
      `node-graph: continuation_save_only_at must be V4HubRespChatProcess03Governed (got ${respSemantics.continuation_save_only_at})`,
    );
  }
  const hookServertool = nodeGraph.hook_queue_schema?.servertool_exception ?? {};
  if (hookServertool.continuation_immutable_interval_semantics !== 'forbidden') {
    failures.push(
      `node-graph: continuation_immutable_interval_semantics must be forbidden (got ${hookServertool.continuation_immutable_interval_semantics})`,
    );
  }
  const selectionFacts = nodeGraph.protocol_same_stage_rule?.selection_facts ?? [];
  for (const fact of SELECTION_FACTS) {
    if (!selectionFacts.includes(fact)) {
      failures.push(`node-graph: selection_facts missing ${fact}`);
    }
  }
  const forbiddenFacts = nodeGraph.protocol_same_stage_rule?.forbidden_selection_facts ?? [];
  for (const fact of FORBIDDEN_SELECTION_FACTS) {
    if (!forbiddenFacts.includes(fact)) {
      failures.push(`node-graph: forbidden_selection_facts missing ${fact}`);
    }
  }

  // Skeleton wiring lock: continuation semantics only inside chat process nodes.
  for (const chain of skeletonPlan.chains ?? []) {
    for (const node of chain.nodes ?? []) {
      const continuationPlugins = (node.plugins ?? [])
        .map((binding) => binding.plugin_id)
        .filter((pluginId) => CONTINUATION_PLUGINS.has(pluginId));
      if (continuationPlugins.length === 0) continue;
      const nodeId = node.node_id ?? '?';
      const isRequestChatProcess = chain.chain_id === "request" && node.node_id === "V4HubReqChatProcess04Governed";
      const isResponseChatProcess = chain.chain_id === "response" && node.node_id === "V4HubRespChatProcess03Governed";
      if (!isRequestChatProcess && !isResponseChatProcess) {
        failures.push(`skeleton: continuation plugins (${continuationPlugins.join(',')}) bound outside chat process at ${chain.chain_id}:${nodeId}`);
      }
      if (chain.chain_id === 'request') {
        for (const pluginId of continuationPlugins) {
          if (!['continuation_classify', 'continuation_restore'].includes(pluginId)) {
            failures.push(`skeleton: request chain binds ${pluginId} (only classify/restore allowed)`);
          }
        }
      }
      if (chain.chain_id === 'response') {
        for (const pluginId of continuationPlugins) {
          if (!['continuation_commit', 'continuation_release'].includes(pluginId)) {
            failures.push(`skeleton: response chain binds ${pluginId} (only commit/release allowed)`);
          }
        }
      }
    }
  }

  // Runtime control-leak guard: wire/frame builders must call the guard.
  if (!/fn assert_no_control_leak/.test(runtimeSource)) {
    failures.push('runtime lib.rs: missing assert_no_control_leak guard');
  }
  const guardedBuilders = ['WireBuild', 'OutputValidate', 'FrameBuild'];
  for (const builder of guardedBuilders) {
    const parts = runtimeSource.split(`struct ${builder};`);
    if (parts.length < 2) {
      failures.push(`runtime lib.rs: missing struct ${builder}`);
      continue;
    }
    const tail = parts[1];
    const nextStruct = tail.indexOf('\nstruct ');
    const block = nextStruct === -1 ? tail : tail.slice(0, nextStruct);
    if (!/assert_no_control_leak/.test(block)) {
      failures.push(`runtime lib.rs: ${builder} must invoke assert_no_control_leak`);
    }
  }
  return failures;
}

function loadInputs() {
  const baselineInfo = loadV3Baseline('v3-resource-operation-map.yml');
  return {
    slice: readYaml('docs/architecture/v4-relay-continuation-compatibility-slice.yml'),
    verification: readJson('.appsdk/maps/verification-map.json'),
    resourceMap: readYaml('docs/architecture/v4-resource-operation-map.yml'),
    v3ResourceMap: readYaml(baselineInfo.artifactPath),
    nodeGraph: readJson('contracts/node-graph.contract.json'),
    skeletonPlan: readJson('contracts/skeleton-plan.contract.json'),
    runtimeSource: readText('crates/routecodex-v4-runtime/src/lib.rs'),
  };
}

function runSelfTest() {
  const base = loadInputs();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    ['missing required surface', ({ slice: s }) => {
      s.surfaces = s.surfaces.filter((surface) => surface.surface_id !== 'audit');
    }],
    ['extra surface', ({ slice: s }) => {
      s.surfaces.push({ surface_id: 'banana', entries: [] });
    }],
    ['duplicate v3_stage', ({ slice: s }) => {
      s.surfaces[0].entries.push(clone(s.surfaces[0].entries[0]));
    }],
    ['unexplained diff', ({ slice: s }) => {
      s.surfaces[0].entries[0].diff_status = 'unexplained';
    }],
    ['unknown v4 resource', ({ slice: s }) => {
      s.surfaces[0].entries[0].v4_resource = 'v4.does.not.exist';
    }],
    ['unregistered verification gate', ({ slice: s }) => {
      s.surfaces[0].entries[0].verification_gates.push('v4_gate_does_not_exist');
    }],
    ['pending evidence', ({ slice: s }) => {
      s.surfaces[0].entries[0].evidence = 'pending_skeleton_vslice';
    }],
    ['unknown checkpoint node', ({ slice: s }) => {
      s.surfaces[0].entries[0].v4_checkpoint.node_id = 'V4GhostNode99';
    }],
    ['checkpoint node only in resource owner_node is circular', ({ nodeGraph: g }) => {
      g.registered_nodes = (g.registered_nodes ?? []).filter((node) => node.node_id !== 'V4ScopeRegistry');
    }],
    ['unknown v3 resource', ({ slice: s }) => {
      s.surfaces[0].entries[0].v3_resource = 'v3.ghost.resource';
    }],
    ['continuation save point drift', ({ nodeGraph: g }) => {
      g.v4_hub_response_chain.semantics.continuation_save_only_at = 'V4ServerRespOutbound06ClientFrame';
    }],
    ['immutable interval semantics drift', ({ nodeGraph: g }) => {
      g.hook_queue_schema.servertool_exception.continuation_immutable_interval_semantics = 'allowed';
    }],
    ['selection facts missing continuation_owner', ({ nodeGraph: g }) => {
      g.protocol_same_stage_rule.selection_facts = ['entry_protocol', 'provider_wire_protocol', 'execution_mode'];
    }],
    ['forbidden selection fact provider_id allowed', ({ nodeGraph: g }) => {
      g.protocol_same_stage_rule.forbidden_selection_facts = ['model_prefix', 'payload_shape_guess'];
    }],
    ['skeleton restore bound to request outbound', ({ skeletonPlan: p }) => {
      const requestChain = p.chains.find((chain) => chain.chain_id === 'request');
      requestChain.nodes[4].plugins.push({ plugin_id: 'continuation_restore', effects: ['control'] });
    }],
    ['skeleton commit bound to response outbound', ({ skeletonPlan: p }) => {
      const responseChain = p.chains.find((chain) => chain.chain_id === 'response');
      responseChain.nodes[3].plugins.push({ plugin_id: 'continuation_commit', effects: ['control'] });
    }],
    ['control-leak guard removed from wire builder', ({ runtimeSource }) => ({
      runtimeSource: runtimeSource.replace(
        'ctx.data.provider_wire = Some(format!("wire:{semantic}"));\n        assert_no_control_leak(ctx)',
        'ctx.data.provider_wire = Some(format!("wire:{semantic}"));\n        Ok(())',
      ),
    })],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const inputs = Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, typeof value === 'string' ? value : clone(value)]),
    );
    const mutated = mutate(inputs);
    if (mutated && typeof mutated === 'object') {
      Object.assign(inputs, mutated);
    }
    const failures = validate(
      inputs.slice,
      inputs.verification,
      inputs.resourceMap,
      inputs.v3ResourceMap,
      inputs.nodeGraph,
      inputs.skeletonPlan,
      inputs.runtimeSource,
    );
    if (failures.length === 0) {
      console.error(`[v4_compat_gate_relay_continuation] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_compat_gate_relay_continuation] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_compat_gate_relay_continuation] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const inputs = loadInputs();
const failures = validate(
  inputs.slice,
  inputs.verification,
  inputs.resourceMap,
  inputs.v3ResourceMap,
  inputs.nodeGraph,
  inputs.skeletonPlan,
  inputs.runtimeSource,
);
if (failures.length > 0) {
  console.error('[v4_compat_gate_relay_continuation] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `[v4_compat_gate_relay_continuation] OK surfaces=6 entries=${(inputs.slice.surfaces ?? []).reduce((n, s) => n + (s.entries ?? []).length, 0)} unexplained_diff=0`,
);
