import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const resourceMapPath = process.env.ROUTECODEX_RESOURCE_MAP_PATH ?? 'docs/architecture/resource-operation-map.yml';
const functionMapPath = process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath = process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const mainlineMapPath = process.env.ROUTECODEX_MAINLINE_MAP_PATH ?? 'docs/architecture/mainline-call-map.yml';
const packageJsonPath = 'package.json';

const failures = [];

function readSourceBindingYaml(relPath) {
  try {
    return YAML.parse(fs.readFileSync(path.resolve(root, relPath), 'utf8'));
  } catch (error) {
    failures.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function relExists(relPath) {
  return fs.existsSync(path.resolve(root, relPath));
}

function readText(relPath) {
  return fs.readFileSync(path.resolve(root, relPath), 'utf8');
}

function listSourceFiles(relPath) {
  const abs = path.resolve(root, relPath);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [relPath];
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['dist', 'node_modules', 'target', 'coverage', '.git'].includes(entry.name)) continue;
        stack.push(next);
        continue;
      }
      if (/\.(rs|ts|tsx|js|mjs|cjs|md|yml|yaml|json)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.relative(root, next));
      }
    }
  }
  return out;
}

function requireString(where, field, value) {
  if (typeof value !== 'string' || !value.trim()) {
    failures.push(`${where}: missing ${field}`);
    return '';
  }
  return value.trim();
}

function requireNonEmptyArray(where, field, value) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${where}: missing ${field}`);
    return [];
  }
  return value;
}

function parseNpmScript(gate) {
  if (typeof gate !== 'string') return '';
  const match = gate.trim().match(/^npm run ([A-Za-z0-9:_-]+)$/);
  return match?.[1] ?? '';
}

function bindingResourceId(value) {
  return typeof value === 'string' ? value.split('@')[0].trim() : '';
}

const resourceMap = readSourceBindingYaml(resourceMapPath);
const functionMap = readSourceBindingYaml(functionMapPath);
const verificationMap = readSourceBindingYaml(verificationMapPath);
const mainlineMap = readSourceBindingYaml(mainlineMapPath);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, packageJsonPath), 'utf8'));
const packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));

const owners = new Map();
for (const owner of asArray(functionMap?.owners)) {
  if (typeof owner?.feature_id === 'string' && owner.feature_id.trim()) {
    owners.set(owner.feature_id.trim(), owner);
  }
}

const verificationIds = new Set();
for (const row of asArray(verificationMap?.verification)) {
  if (typeof row?.feature_id === 'string' && row.feature_id.trim()) {
    verificationIds.add(row.feature_id.trim());
  }
}

const resources = new Map();
for (const [index, resource] of asArray(resourceMap?.resources).entries()) {
  const where = `resources[${index}]`;
  const resourceId = requireString(where, 'resource_id', resource?.resource_id);
  if (!resourceId) continue;
  if (resources.has(resourceId)) failures.push(`${where}: duplicate resource_id ${resourceId}`);
  resources.set(resourceId, resource);
}

function validateOwnerSourceAnchor(where, featureId) {
  const owner = owners.get(featureId);
  if (!owner) {
    failures.push(`${where}: owner_feature_id not found in function-map: ${featureId}`);
    return;
  }
  if (!verificationIds.has(featureId)) {
    failures.push(`${where}: owner_feature_id missing verification-map entry: ${featureId}`);
  }

  const searchPaths = Array.from(new Set([
    ...(typeof owner.owner_module === 'string' ? [owner.owner_module] : []),
    ...asArray(owner.allowed_paths).filter((item) => typeof item === 'string'),
  ]));
  if (searchPaths.length === 0) {
    failures.push(`${where}: owner feature ${featureId} has no owner_module/allowed_paths source anchor surface`);
    return;
  }

  const files = [];
  for (const relPath of searchPaths) {
    if (!relExists(relPath)) {
      failures.push(`${where}: owner feature ${featureId} source path missing: ${relPath}`);
      continue;
    }
    files.push(...listSourceFiles(relPath));
  }

  const anchor = `feature_id: ${featureId}`;
  let anchorHit = false;
  const builderHits = new Set();
  const canonicalBuilders = asArray(owner.canonical_builders).filter((item) => typeof item === 'string' && item.trim());
  for (const file of new Set(files)) {
    const source = readText(file);
    if (source.includes(anchor)) anchorHit = true;
    for (const builder of canonicalBuilders) {
      if (source.includes(builder)) builderHits.add(builder);
    }
  }
  if (!anchorHit) {
    failures.push(`${where}: owner feature ${featureId} missing source anchor "${anchor}" under owner_module/allowed_paths`);
  }
  if (canonicalBuilders.length > 0 && builderHits.size === 0) {
    failures.push(`${where}: owner feature ${featureId} canonical_builders have no source hits`);
  }
}

for (const [index, resource] of asArray(resourceMap?.resources).entries()) {
  const where = `resources[${index}] ${resource?.resource_id ?? ''}`;
  const resourceId = resource?.resource_id;
  const ownerFeatureId = requireString(where, 'owner_feature_id', resource?.owner_feature_id);
  requireString(where, 'owner_node', resource?.owner_node);
  requireNonEmptyArray(where, 'identity', resource?.identity);
  const allowedWriters = requireNonEmptyArray(where, 'allowed_writers', resource?.allowed_writers);
  requireNonEmptyArray(where, 'allowed_readers', resource?.allowed_readers);
  const forbiddenWriters = requireNonEmptyArray(where, 'forbidden_writers', resource?.forbidden_writers);
  const requiredGates = requireNonEmptyArray(where, 'required_gates', resource?.required_gates);

  if (ownerFeatureId) validateOwnerSourceAnchor(where, ownerFeatureId);

  const overlap = allowedWriters.filter((writer) => forbiddenWriters.includes(writer));
  for (const writer of overlap) {
    failures.push(`${where}: forbidden_writers overlaps allowed_writers: ${writer}`);
  }

  if (resource?.resource_kind === 'side_channel') {
    if (resource.may_enter_provider_body !== false) failures.push(`${where}: side_channel resource may_enter_provider_body must be false`);
    if (resource.may_enter_client_body !== false) failures.push(`${where}: side_channel resource may_enter_client_body must be false`);
  }

  for (const gate of requiredGates) {
    const script = parseNpmScript(gate);
    if (!script) {
      failures.push(`${where}: required_gates entry must be "npm run <script>": ${String(gate)}`);
      continue;
    }
    if (!packageScripts.has(script)) {
      failures.push(`${where}: required gate script missing in package.json: ${script}`);
    }
  }

  const ownerBindings = owners.get(ownerFeatureId)?.resource_bindings;
  const ownerRefs = [];
  for (const field of ['reads', 'writes', 'projects', 'observes', 'forbidden']) {
    for (const value of asArray(ownerBindings?.[field])) ownerRefs.push(bindingResourceId(value));
  }
  if (resourceId && !ownerRefs.includes(resourceId)) {
    failures.push(`${where}: owner feature ${ownerFeatureId} does not bind resource ${resourceId}`);
  }
}

const chainEdges = new Map();
for (const chain of asArray(mainlineMap?.chains)) {
  for (const edge of asArray(chain?.edges)) {
    if (typeof chain?.chain_id === 'string' && typeof edge?.step_id === 'string') {
      chainEdges.set(`${chain.chain_id}::${edge.step_id}`, edge);
    }
  }
}

for (const [index, flow] of asArray(resourceMap?.mainline_resource_flows).entries()) {
  const where = `mainline_resource_flows[${index}]`;
  const chainId = requireString(where, 'chain_id', flow?.chain_id);
  const stepId = requireString(where, 'step_id', flow?.step_id);
  const edge = chainEdges.get(`${chainId}::${stepId}`);
  if (!edge) {
    failures.push(`${where}: fake/non-adjacent mainline flow; edge not found ${chainId}::${stepId}`);
  }
  for (const field of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
    for (const resourceId of asArray(flow?.[field])) {
      const resource = resources.get(resourceId);
      if (!resource) {
        failures.push(`${where}: ${field} references undeclared resource: ${String(resourceId)}`);
        continue;
      }
      if ((field === 'side_channel_reads' || field === 'side_channel_writes') && resource.resource_kind !== 'side_channel') {
        failures.push(`${where}: ${field} uses non-side-channel resource as carrier: ${resourceId}`);
      }
    }
  }
}

for (const owner of owners.values()) {
  const featureId = owner.feature_id;
  for (const field of ['reads', 'writes', 'projects', 'observes', 'forbidden']) {
    for (const value of asArray(owner.resource_bindings?.[field])) {
      const resourceId = bindingResourceId(value);
      if (!resources.has(resourceId)) {
        failures.push(`function-map ${featureId}: resource_bindings.${field} references undeclared resource ${resourceId}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:resource-source-bindings] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:resource-source-bindings] ok');
console.log(`- resources checked: ${resources.size}`);
console.log(`- owner source anchors checked: ${new Set([...resources.values()].map((resource) => resource.owner_feature_id)).size}`);
console.log(`- mainline flows checked: ${asArray(resourceMap?.mainline_resource_flows).length}`);
