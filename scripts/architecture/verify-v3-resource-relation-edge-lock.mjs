#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const files = {
  resourceMap: process.env.ROUTECODEX_V3_RESOURCE_MAP_PATH ?? 'docs/architecture/v3-resource-operation-map.yml',
  mainlineMap: process.env.ROUTECODEX_V3_MAINLINE_CALL_MAP_PATH ?? 'docs/architecture/v3-mainline-call-map.yml',
  functionMap: process.env.ROUTECODEX_V3_FUNCTION_MAP_PATH ?? 'docs/architecture/v3-function-map.yml',
  verificationMap: process.env.ROUTECODEX_V3_VERIFICATION_MAP_PATH ?? 'docs/architecture/v3-verification-map.yml',
  packageJson: process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json',
  verifier: 'scripts/architecture/verify-v3-resource-relation-edge-lock.mjs',
  redFixture: 'scripts/tests/v3-resource-relation-edge-lock-red-fixtures.mjs',
};

const featureId = 'v3.resource_relation_edge_lock';
const verifyGate = 'npm run verify:v3-resource-relation-edge-lock';
const redGate = 'npm run test:v3-resource-relation-edge-lock-red-fixtures';
const architectureDocsGate = 'npm run verify:v3-architecture-docs';
const resourceFlowFields = ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes'];
const resourceFlowFieldSet = new Set(resourceFlowFields);
const forbiddenResourceRelationFields = new Set([
  'edge',
  'edges',
  'resource_edge',
  'resource_edges',
  'resource_flow',
  'resource_flows',
  'relation',
  'relations',
  'resource_relation',
  'resource_relations',
  'resource_relationship',
  'resource_relationships',
  'from_node',
  'to_node',
  'source_node',
  'target_node',
  'from_resource',
  'to_resource',
  'source_resource',
  'target_resource',
  'depends_on',
  'consumes',
  'produces',
  'side_channel_reads',
  'side_channel_writes',
]);
const forbiddenEdgePathShortcutFields = new Set([
  'from_nodes',
  'to_nodes',
  'source_nodes',
  'target_nodes',
  'sources',
  'targets',
  'paths',
  'path_targets',
  'next_nodes',
]);
const forbiddenEdgeTopLevelResourceFields = new Set([
  'consumes',
  'produces',
  'side_channel_reads',
  'side_channel_writes',
  'resource_edge',
  'resource_edges',
  'resource_relation',
  'resource_relations',
  'resource_relationship',
  'resource_relationships',
  'resources',
  'resource_ids',
  'from_resource',
  'to_resource',
  'source_resource',
  'target_resource',
]);

const resourceMap = readYaml(files.resourceMap);
const mainlineMap = readYaml(files.mainlineMap);
const functionMap = readYaml(files.functionMap);
const verificationMap = readYaml(files.verificationMap);
const packageJson = readJson(files.packageJson);

requirePackageScript('verify:v3-resource-relation-edge-lock', 'node scripts/architecture/verify-v3-resource-relation-edge-lock.mjs');
requirePackageScript('test:v3-resource-relation-edge-lock-red-fixtures', 'node scripts/tests/v3-resource-relation-edge-lock-red-fixtures.mjs');
requirePackageScriptContains('verify:v3-architecture-docs', 'verify:v3-resource-relation-edge-lock');
for (const rel of [files.verifier, files.redFixture]) {
  if (!fs.existsSync(abs(rel))) fail(rel + ': missing resource relation edge lock file');
}

const resourceIds = verifyResourceMap(resourceMap);
const resourceUsage = verifyMainlineEdges(mainlineMap, resourceIds);
verifyAllResourcesUsed(resourceIds, resourceUsage);
verifyFunctionResourceBindings(functionMap, resourceIds, resourceUsage);
verifyGateMaps(functionMap, verificationMap);

if (failures.length) {
  console.error('[verify:v3-resource-relation-edge-lock] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[verify:v3-resource-relation-edge-lock] ok (' + resourceIds.size + ' resources bound through ' + resourceUsage.edgeCount + ' edge resource_flow payloads)');

function abs(rel) {
  return path.resolve(root, rel);
}

function readText(rel) {
  try {
    return fs.readFileSync(abs(rel), 'utf8');
  } catch (error) {
    fail(rel + ': cannot read: ' + error.message);
    return '';
  }
}

function readYaml(rel) {
  try {
    return YAML.parse(readText(rel)) ?? {};
  } catch (error) {
    fail(rel + ': YAML parse failed: ' + error.message);
    return {};
  }
}

function readJson(rel) {
  try {
    return JSON.parse(readText(rel));
  } catch (error) {
    fail(rel + ': JSON parse failed: ' + error.message);
    return {};
  }
}

function fail(message) {
  failures.push(message);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function edgeLabel(chain, index, edge) {
  return files.mainlineMap + ': ' + (chain?.chain_id ?? '<unknown-chain>') + ' edge[' + index + '] ' + (edge?.step_id ?? '<missing-step_id>');
}

function verifyResourceDoesNotEncodeRelations(value, where, trail = '') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      verifyResourceDoesNotEncodeRelations(item, where, trail + '[' + index + '].');
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = trail + key;
    if (forbiddenResourceRelationFields.has(key)) {
      fail(where + ': resource map must not encode relationship field ' + fieldPath + '; put resource relationships only under mainline edge resource_flow');
    }
    verifyResourceDoesNotEncodeRelations(child, where, fieldPath + '.');
  }
}

function verifyResourceMap(parsed) {
  const resources = array(parsed?.resources);
  const ids = new Set();
  for (const [index, resource] of resources.entries()) {
    const where = files.resourceMap + ': resource[' + index + '] ' + (resource?.resource_id ?? '<missing-resource_id>');
    if (!isPlainObject(resource)) {
      fail(where + ': resource entry must be an object');
      continue;
    }
    if (typeof resource.resource_id !== 'string' || resource.resource_id.length === 0) {
      fail(where + ': resource_id must be a non-empty string');
      continue;
    }
    if (ids.has(resource.resource_id)) fail(where + ': duplicate resource_id');
    ids.add(resource.resource_id);
    verifyResourceDoesNotEncodeRelations(resource, where);
  }
  if (ids.size === 0) fail(files.resourceMap + ': no resources found');
  return ids;
}

function verifyMainlineEdges(parsed, resourceIds) {
  const used = new Map();
  const seenStepIds = new Set();
  let edgeCount = 0;
  for (const [chainIndex, chain] of array(parsed?.chains).entries()) {
    const edges = array(chain?.edges);
    if (!chain?.chain_id) fail(files.mainlineMap + ': chain[' + chainIndex + '] missing chain_id');
    if (edges.length === 0) fail(files.mainlineMap + ': ' + (chain?.chain_id ?? ('chain[' + chainIndex + ']')) + ': missing edges');
    for (const [edgeIndex, edge] of edges.entries()) {
      edgeCount += 1;
      const where = edgeLabel(chain, edgeIndex, edge);
      if (!isPlainObject(edge)) {
        fail(where + ': edge must be an object');
        continue;
      }
      if (!edge.step_id) fail(where + ': missing step_id');
      else if (seenStepIds.has(edge.step_id)) fail(where + ': duplicate step_id ' + edge.step_id);
      else seenStepIds.add(edge.step_id);

      if (Array.isArray(edge.from_node)) fail(where + ': from_node must be one source node string; multiple paths require multiple edges');
      else if (typeof edge.from_node !== 'string' || edge.from_node.length === 0) fail(where + ': from_node must be a non-empty string');
      if (Array.isArray(edge.to_node)) fail(where + ': to_node must be one target node string; multiple paths require multiple edges');
      else if (typeof edge.to_node !== 'string' || edge.to_node.length === 0) fail(where + ': to_node must be a non-empty string');
      if (typeof edge.from_node === 'string' && edge.from_node === edge.to_node) {
        fail(where + ': from_node and to_node must differ');
      }

      for (const key of Object.keys(edge)) {
        if (forbiddenEdgePathShortcutFields.has(key)) {
          fail(where + ': path shortcut field ' + key + ' is forbidden; multiple callable paths require multiple edges');
        }
        if (forbiddenEdgeTopLevelResourceFields.has(key)) {
          fail(where + ': resource relationship field ' + key + ' must be nested under resource_flow');
        }
      }

      const flow = edge.resource_flow;
      if (!isPlainObject(flow)) {
        fail(where + ': missing resource_flow object; every callable path edge must carry resource relationships');
        continue;
      }
      const flowKeys = Object.keys(flow);
      for (const key of flowKeys) {
        if (!resourceFlowFieldSet.has(key)) {
          fail(where + ': unknown resource_flow field ' + key + '; allowed fields are ' + resourceFlowFields.join(', '));
        }
      }
      let relationCount = 0;
      for (const field of resourceFlowFields) {
        if (!Array.isArray(flow[field])) {
          fail(where + ': resource_flow.' + field + ' must be an array');
          continue;
        }
        for (const resourceId of flow[field]) {
          relationCount += 1;
          if (typeof resourceId !== 'string' || resourceId.length === 0) {
            fail(where + ': resource_flow.' + field + ' must contain resource id strings');
            continue;
          }
          if (!resourceIds.has(resourceId)) {
            fail(where + ': undeclared resource ' + resourceId);
            continue;
          }
          const uses = used.get(resourceId) ?? [];
          uses.push((chain?.chain_id ?? '<unknown-chain>') + ':' + edge.step_id + ':' + field);
          used.set(resourceId, uses);
        }
      }
      if (relationCount === 0) {
        fail(where + ': resource_flow must declare at least one resource relationship');
      }
    }
  }
  if (edgeCount === 0) fail(files.mainlineMap + ': no mainline edges found');
  used.edgeCount = edgeCount;
  return used;
}

function verifyAllResourcesUsed(resourceIds, resourceUsage) {
  for (const resourceId of [...resourceIds].sort()) {
    if (!resourceUsage.has(resourceId)) {
      fail(files.resourceMap + ': resource ' + resourceId + ' is not referenced by any mainline edge resource_flow');
    }
  }
}

function verifyFunctionResourceBindings(parsed, resourceIds, resourceUsage) {
  for (const feature of array(parsed?.features)) {
    const featureIdValue = feature?.feature_id ?? '<missing-feature_id>';
    for (const resourceId of array(feature?.resource_bindings)) {
      if (!resourceIds.has(resourceId)) {
        fail(files.functionMap + ': ' + featureIdValue + ' resource binding ' + resourceId + ' is not declared in resource map');
      } else if (!resourceUsage.has(resourceId)) {
        fail(files.functionMap + ': ' + featureIdValue + ' resource binding ' + resourceId + ' is not carried by any mainline edge resource_flow');
      }
    }
  }
}

function verifyGateMaps(functionMapParsed, verificationMapParsed) {
  const functionFeature = array(functionMapParsed?.features).find((feature) => feature?.feature_id === featureId);
  if (!functionFeature) {
    fail(files.functionMap + ': missing feature ' + featureId);
  } else {
    for (const resourceId of ['v3.config.resource_registry']) {
      if (!array(functionFeature.resource_bindings).includes(resourceId)) {
        fail(files.functionMap + ': ' + featureId + ' missing resource binding ' + resourceId);
      }
    }
    for (const gate of [verifyGate, redGate, architectureDocsGate]) {
      if (!array(functionFeature.required_gates).includes(gate)) {
        fail(files.functionMap + ': ' + featureId + ' missing required gate ' + gate);
      }
    }
    for (const rel of [files.verifier, files.redFixture, files.resourceMap, files.mainlineMap, files.functionMap, files.verificationMap, files.packageJson]) {
      if (!array(functionFeature.allowed_paths).includes(rel)) {
        fail(files.functionMap + ': ' + featureId + ' missing allowed path ' + rel);
      }
    }
  }

  const verificationFeature = array(verificationMapParsed?.features).find((feature) => feature?.feature_id === featureId);
  if (!verificationFeature) {
    fail(files.verificationMap + ': missing feature ' + featureId);
  } else {
    for (const gate of [verifyGate, redGate, architectureDocsGate]) {
      if (!array(verificationFeature.required_gates).includes(gate)) {
        fail(files.verificationMap + ': ' + featureId + ' missing required gate ' + gate);
      }
    }
    const requiredContract = array(verificationFeature.required_contract).join('\n');
    for (const phrase of [
      'Resources are nodes/truth resources, not edges',
      'resource_flow',
      'Multiple callable paths require multiple edges',
    ]) {
      if (!requiredContract.includes(phrase)) {
        fail(files.verificationMap + ': ' + featureId + ' required_contract missing phrase ' + phrase);
      }
    }
  }
}

function requirePackageScript(name, expectedCommand) {
  const actual = packageJson?.scripts?.[name];
  if (actual !== expectedCommand) {
    fail(files.packageJson + ': script ' + name + ' must be ' + expectedCommand);
  }
}

function requirePackageScriptContains(name, expectedSubstring) {
  const actual = packageJson?.scripts?.[name];
  if (typeof actual !== 'string' || !actual.includes(expectedSubstring)) {
    fail(files.packageJson + ': script ' + name + ' must invoke ' + expectedSubstring);
  }
}
