import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const resourceMapPath = 'docs/architecture/resource-operation-map.yml';
const functionMapPath = 'docs/architecture/function-map.yml';
const verificationMapPath = 'docs/architecture/verification-map.yml';
const mainlineMapPath = 'docs/architecture/mainline-call-map.yml';
const packageJsonPath = 'package.json';

const failures = [];

function readYaml(relPath) {
  const absPath = path.join(root, relPath);
  try {
    return YAML.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (error) {
    failures.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requireString(where, field, value) {
  if (typeof value !== 'string' || !value.trim()) {
    failures.push(`${where}: missing ${field}`);
    return '';
  }
  return value.trim();
}

function requireStringArray(where, field, value) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${where}: missing ${field}`);
    return [];
  }
  const normalized = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim()) {
      failures.push(`${where}: ${field}[${index}] must be a non-empty string`);
      continue;
    }
    normalized.push(item.trim());
  }
  return normalized;
}

const resourceMap = readYaml(resourceMapPath);
const functionMap = readYaml(functionMapPath);
const verificationMap = readYaml(verificationMapPath);
const mainlineMap = readYaml(mainlineMapPath);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, packageJsonPath), 'utf8'));
const scripts = packageJson.scripts ?? {};

if (!resourceMap || typeof resourceMap !== 'object') {
  failures.push(`${resourceMapPath}: parsed to empty/non-object root`);
}
if (resourceMap?.version !== 1) {
  failures.push(`${resourceMapPath}: version must be 1`);
}

const featureIds = new Set(asArray(functionMap?.owners).map((row) => row?.feature_id).filter(Boolean));
const verificationIds = new Set(asArray(verificationMap?.verification).map((row) => row?.feature_id).filter(Boolean));
const resourceIds = new Set();
const writerOwners = new Map();

for (const [index, resource] of asArray(resourceMap?.resources).entries()) {
  const where = `resources[${index}]`;
  const resourceId = requireString(where, 'resource_id', resource?.resource_id);
  if (!resourceId) continue;
  if (resourceIds.has(resourceId)) {
    failures.push(`${where}: duplicate resource_id ${resourceId}`);
  }
  resourceIds.add(resourceId);

  requireString(where, 'resource_kind', resource?.resource_kind);
  requireString(where, 'lifecycle', resource?.lifecycle);
  requireString(where, 'owner_node', resource?.owner_node);
  const ownerFeatureId = requireString(where, 'owner_feature_id', resource?.owner_feature_id);
  if (ownerFeatureId && !featureIds.has(ownerFeatureId)) {
    failures.push(`${where}: owner_feature_id not found in function-map: ${ownerFeatureId}`);
  }
  if (ownerFeatureId && !verificationIds.has(ownerFeatureId)) {
    failures.push(`${where}: owner_feature_id missing verification-map entry: ${ownerFeatureId}`);
  }

  const allowedWriters = requireStringArray(where, 'allowed_writers', resource?.allowed_writers);
  requireStringArray(where, 'allowed_readers', resource?.allowed_readers);
  requireStringArray(where, 'identity', resource?.identity);
  requireStringArray(where, 'forbidden_writers', resource?.forbidden_writers);
  const requiredGates = requireStringArray(where, 'required_gates', resource?.required_gates);

  for (const gate of requiredGates) {
    const match = gate.match(/^npm run ([A-Za-z0-9:_-]+)$/);
    if (!match) {
      failures.push(`${where}: required gate must use "npm run <script>": ${gate}`);
      continue;
    }
    if (!scripts[match[1]]) {
      failures.push(`${where}: required gate script missing in package.json: ${match[1]}`);
    }
  }

  for (const writer of allowedWriters) {
    const key = `${resourceId}::${writer}`;
    const previousOwner = writerOwners.get(key);
    if (previousOwner && previousOwner !== ownerFeatureId) {
      failures.push(`${where}: writer ${writer} for ${resourceId} already owned by ${previousOwner}, got ${ownerFeatureId}`);
    }
    writerOwners.set(key, ownerFeatureId);
  }

  if (resource?.resource_kind === 'side_channel') {
    if (resource?.may_enter_provider_body !== false) {
      failures.push(`${where}: side_channel resource must not enter provider body`);
    }
    if (resource?.may_enter_client_body !== false) {
      failures.push(`${where}: side_channel resource must not enter client body`);
    }
  }
}

const chainEdges = new Map();
for (const chain of asArray(mainlineMap?.chains)) {
  const chainId = typeof chain?.chain_id === 'string' ? chain.chain_id : '';
  for (const edge of asArray(chain?.edges)) {
    if (chainId && typeof edge?.step_id === 'string') {
      chainEdges.set(`${chainId}::${edge.step_id}`, edge);
    }
  }
}

function normalizeList(value) {
  return asArray(value).map((item) => String(item)).sort();
}

function assertSameList(where, field, expected, actual) {
  const expectedList = normalizeList(expected);
  const actualList = normalizeList(actual);
  if (JSON.stringify(expectedList) !== JSON.stringify(actualList)) {
    failures.push(`${where}: mainline resource_flow.${field} mismatch; expected ${JSON.stringify(expectedList)}, got ${JSON.stringify(actualList)}`);
  }
}

const declaredFlows = new Set();
for (const [index, flow] of asArray(resourceMap?.mainline_resource_flows).entries()) {
  const where = `mainline_resource_flows[${index}]`;
  const chainId = requireString(where, 'chain_id', flow?.chain_id);
  const stepId = requireString(where, 'step_id', flow?.step_id);
  if (chainId && stepId) {
    const key = `${chainId}::${stepId}`;
    if (declaredFlows.has(key)) {
      failures.push(`${where}: duplicate resource flow for ${key}`);
    }
    declaredFlows.add(key);
    const edge = chainEdges.get(key);
    if (!edge) {
      failures.push(`${where}: mainline edge not found: ${key}`);
    } else if (!edge.resource_flow || typeof edge.resource_flow !== 'object') {
      failures.push(`${where}: mainline edge ${key} missing resource_flow`);
    } else {
      assertSameList(where, 'consumes', flow.consumes, edge.resource_flow.consumes);
      assertSameList(where, 'produces', flow.produces, edge.resource_flow.produces);
      assertSameList(where, 'side_channel_reads', flow.side_channel_reads, edge.resource_flow.side_channel_reads);
      assertSameList(where, 'side_channel_writes', flow.side_channel_writes, edge.resource_flow.side_channel_writes);
    }
  }

  for (const field of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
    for (const resourceId of asArray(flow?.[field])) {
      if (typeof resourceId !== 'string' || !resourceIds.has(resourceId)) {
        failures.push(`${where}: ${field} references undeclared resource: ${String(resourceId)}`);
      }
    }
  }

  const normalPayloadSideChannels = [...asArray(flow?.side_channel_reads), ...asArray(flow?.side_channel_writes)]
    .filter((resourceId) => {
      const resource = asArray(resourceMap?.resources).find((row) => row?.resource_id === resourceId);
      return resource && resource.resource_kind !== 'side_channel';
    });
  for (const resourceId of normalPayloadSideChannels) {
    failures.push(`${where}: side-channel field references non-side-channel resource ${resourceId}`);
  }
}

const functionResourceBindings = new Map();
for (const owner of asArray(functionMap?.owners)) {
  const featureId = owner?.feature_id;
  const bindings = owner?.resource_bindings;
  if (!featureId || !bindings) continue;
  const refs = [];
  for (const field of ['reads', 'writes', 'projects', 'observes', 'forbidden']) {
    for (const value of asArray(bindings?.[field])) {
      if (typeof value !== 'string') {
        failures.push(`function-map ${featureId}: resource_bindings.${field} entry must be string`);
        continue;
      }
      const resourceId = value.split('@')[0].trim();
      if (!resourceIds.has(resourceId)) {
        failures.push(`function-map ${featureId}: resource_bindings.${field} references undeclared resource ${resourceId}`);
      }
      refs.push(resourceId);
    }
  }
  functionResourceBindings.set(featureId, refs);
}

for (const resource of asArray(resourceMap?.resources)) {
  const ownerFeatureId = resource?.owner_feature_id;
  const resourceId = resource?.resource_id;
  const refs = functionResourceBindings.get(ownerFeatureId) ?? [];
  if (!refs.includes(resourceId)) {
    failures.push(`resource ${resourceId}: owner feature ${ownerFeatureId} must include resource_bindings reference`);
  }
}

if (failures.length > 0) {
  console.error('[verify:resource-operation-map] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:resource-operation-map] ok');
console.log(`- resources: ${resourceIds.size}`);
console.log(`- mainline resource flows: ${declaredFlows.size}`);
console.log(`- feature resource bindings: ${functionResourceBindings.size}`);
