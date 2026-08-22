import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const functionMapPath = 'docs/architecture/function-map.yml';
const mainlineMapPath = 'docs/architecture/mainline-call-map.yml';
const resourceMapPath = 'docs/architecture/resource-operation-map.yml';
const failOnMissing = process.argv.includes('--fail-on-missing');

function readCoverageYaml(relPath) {
  return YAML.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const functionMap = readCoverageYaml(functionMapPath);
const mainlineMap = readCoverageYaml(mainlineMapPath);
const resourceMap = readCoverageYaml(resourceMapPath);

const activeOwners = asArray(functionMap.owners).filter((owner) => owner?.status === 'active');
const ownersWithBindings = activeOwners.filter((owner) => owner.resource_bindings);
const ownersMissingBindings = activeOwners
  .filter((owner) => !owner.resource_bindings)
  .map((owner) => owner.feature_id)
  .filter(Boolean);

const allEdges = [];
for (const chain of asArray(mainlineMap.chains)) {
  for (const edge of asArray(chain.edges)) {
    allEdges.push({
      chain_id: chain.chain_id,
      step_id: edge.step_id,
      owner_feature_id: edge.owner_feature_id,
      has_resource_flow: Boolean(edge.resource_flow)
    });
  }
}

const edgesWithResourceFlow = allEdges.filter((edge) => edge.has_resource_flow);
const edgesMissingResourceFlow = allEdges.filter((edge) => !edge.has_resource_flow);

const resources = asArray(resourceMap.resources);
const mainlineResourceFlows = asArray(resourceMap.mainline_resource_flows);

const report = {
  status: 'audit',
  scope: 'project-wide-resource-convergence',
  resources: resources.length,
  mainline_resource_flows: mainlineResourceFlows.length,
  active_features: activeOwners.length,
  active_features_with_resource_bindings: ownersWithBindings.length,
  active_features_missing_resource_bindings: ownersMissingBindings.length,
  mainline_edges: allEdges.length,
  mainline_edges_with_resource_flow: edgesWithResourceFlow.length,
  mainline_edges_missing_resource_flow: edgesMissingResourceFlow.length,
  missing_resource_bindings: ownersMissingBindings,
  missing_resource_flow_edges: edgesMissingResourceFlow.map((edge) => ({
    chain_id: edge.chain_id,
    step_id: edge.step_id,
    owner_feature_id: edge.owner_feature_id
  }))
};

console.log('[audit:resource-global-coverage]');
console.log(`- resources: ${report.resources}`);
console.log(`- mainline resource flows: ${report.mainline_resource_flows}`);
console.log(`- active features with resource_bindings: ${report.active_features_with_resource_bindings}/${report.active_features}`);
console.log(`- mainline edges with resource_flow: ${report.mainline_edges_with_resource_flow}/${report.mainline_edges}`);

if (ownersMissingBindings.length > 0) {
  console.log('- first missing resource_bindings:');
  for (const featureId of ownersMissingBindings.slice(0, 20)) {
    console.log(`  - ${featureId}`);
  }
}

if (edgesMissingResourceFlow.length > 0) {
  console.log('- first missing resource_flow edges:');
  for (const edge of edgesMissingResourceFlow.slice(0, 20)) {
    console.log(`  - ${edge.chain_id} ${edge.step_id} ${edge.owner_feature_id}`);
  }
}

const outPath = path.join(root, 'docs/architecture/resource-global-coverage-report.json');
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`- wrote: ${path.relative(root, outPath)}`);

if (failOnMissing && (ownersMissingBindings.length > 0 || edgesMissingResourceFlow.length > 0)) {
  console.error('[audit:resource-global-coverage] project-wide resource coverage is incomplete');
  process.exit(1);
}
