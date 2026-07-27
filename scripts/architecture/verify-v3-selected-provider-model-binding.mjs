#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const files = {
  owner: 'v3/crates/routecodex-v3-runtime/src/selected_provider_model_binding.rs',
  direct: 'v3/crates/routecodex-v3-runtime/src/hooks.rs',
  relay: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  providerWire: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
  providerError: 'v3/crates/routecodex-v3-provider-responses/src/error.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.selected_provider_model_binding.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-selected-provider-model-binding.md',
  wikiHtml: 'docs/architecture/wiki/html/v3-selected-provider-model-binding.html',
  design: 'docs/design/v3-selected-provider-model-binding.md',
  testDesign: 'docs/goals/v3-selected-provider-model-binding-test-design.md',
  sop: '.agents/skills/rcc-dev-skills/references/96-v3-selected-provider-model-binding-sop.md',
  packageJson: 'package.json',
};

const abs = (rel) => path.join(root, rel);
const read = (rel) => {
  try { return fs.readFileSync(abs(rel), 'utf8'); }
  catch (error) { failures.push(`${rel}: cannot read: ${error.message}`); return ''; }
};
const requireText = (text, rel, token) => {
  if (!text.includes(token)) failures.push(`${rel}: missing ${token}`);
};
const parseYaml = (rel) => {
  try { return YAML.parse(read(rel)); }
  catch (error) { failures.push(`${rel}: YAML parse failed: ${error.message}`); return {}; }
};

for (const rel of Object.values(files)) {
  if (!fs.existsSync(abs(rel))) failures.push(`${rel}: missing required file`);
}
const text = Object.fromEntries(Object.entries(files).map(([key, rel]) => [key, read(rel)]));
let packageJson = {};
try { packageJson = JSON.parse(text.packageJson); }
catch (error) { failures.push(`package.json: JSON parse failed: ${error.message}`); }
for (const [name, command] of Object.entries({
  'verify:v3-selected-provider-model-binding': 'node scripts/architecture/verify-v3-selected-provider-model-binding.mjs',
  'test:v3-selected-provider-model-binding-red-fixtures': 'node scripts/tests/v3-selected-provider-model-binding-red-fixtures.mjs',
})) {
  if (packageJson.scripts?.[name] !== command) failures.push(`package.json: script ${name} must equal ${command}`);
}
for (const [scriptName, required] of [
  ['verify:v3-architecture-docs', 'npm run verify:v3-selected-provider-model-binding'],
  ['build:v3-cli', 'npm run verify:v3-selected-provider-model-binding'],
]) {
  if (!String(packageJson.scripts?.[scriptName] || '').includes(required)) {
    failures.push(`package.json: ${scriptName} must run ${required}`);
  }
}

requireText(text.owner, files.owner, 'feature_id: v3.route_selected_provider_model_binding');
requireText(text.owner, files.owner, 'pub(crate) fn bind_v3_selected_provider_model');
const ownerWrites = [...text.owner.matchAll(/insert\("model"\.to_string\(\),\s*Value::String\(wire_model\.to_string\(\)\)\)/gu)].length;
requireText(text.owner, files.owner, 'selected.wire_model.as_str()');
requireText(text.owner, files.owner, 'wire_model != wire_model.trim()');
if (ownerWrites !== 1) failures.push(`${files.owner}: shared owner must perform exactly one selected wire-model write, found ${ownerWrites}`);

const directBind = text.direct.indexOf('bind_v3_selected_provider_model(');
const directWire = text.direct.indexOf('build_v3_provider_12_responses_wire_payload(', directBind);
if (directBind < 0 || directWire < 0 || directBind > directWire) {
  failures.push(`${files.direct}: Direct must bind selected model before Provider12 wire build`);
}
requireText(text.direct, files.direct, 'provider_model_binding_mismatch');
requireText(text.direct, files.direct, 'V3ErrorSourceKind::RuntimeFailure');

const relayBuilderStart = text.relay.indexOf('fn build_v3_provider_standard_protocol_payload_from_req07');
const relayBind = text.relay.indexOf('bind_v3_selected_provider_model(', relayBuilderStart);
if (relayBuilderStart < 0 || relayBind < relayBuilderStart) {
  failures.push(`${files.relay}: Relay protocol payload builder must call the shared selected-model owner`);
}
const compatStart = text.relay.indexOf('fn apply_v3_provider_req_compat');
const compatRun = text.relay.indexOf('run_req_outbound_stage3_compat(', compatStart);
const boundBuilderCall = text.relay.indexOf('build_v3_provider_standard_protocol_payload_from_req07(input)', compatStart);
if (compatStart < 0 || compatRun < 0 || boundBuilderCall < 0 || boundBuilderCall > compatRun + 500) {
  failures.push(`${files.relay}: ProviderReqCompat06 must receive the bound protocol payload`);
}

requireText(text.providerError, files.providerError, 'ProviderModelBindingMismatch');
requireText(text.providerWire, files.providerWire, 'actual_model.as_deref() != Some(target.wire_model.as_str())');
requireText(text.providerWire, files.providerWire, '.and_then(Value::as_str)\n        .map(str::to_string);');
requireText(text.providerWire, files.providerWire, 'V3ProviderError::ProviderModelBindingMismatch');
for (const forbidden of [
  'body.insert("model"',
  'body["model"] =',
  'current_request_body.insert("model"',
]) {
  if (text.providerWire.includes(forbidden)) failures.push(`${files.providerWire}: Provider12 must validate model equality, not repair via ${forbidden}`);
}

const productionRoots = [
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src',
  'v3/crates/routecodex-v3-target/src',
  'v3/crates/routecodex-v3-virtual-router/src',
];
const wireModelWriteHits = [];
for (const base of productionRoots) {
  for (const rel of walkRust(base)) {
    const source = read(rel);
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const window = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
      if (/wire_model/u.test(window) && /(insert\("model"|\["model"\]\s*=)/u.test(lines[index])) {
        wireModelWriteHits.push(`${rel}:${index + 1}`);
      }
    }
  }
}
const expectedOwnerPrefix = `${files.owner}:`;
if (wireModelWriteHits.length !== 1 || !wireModelWriteHits[0].startsWith(expectedOwnerPrefix)) {
  failures.push(`selected wire-model semantic write must have one owner; hits=${wireModelWriteHits.join(',') || 'none'}`);
}
for (const rel of [
  'v3/crates/routecodex-v3-runtime/src/hub_v1',
  'v3/crates/routecodex-v3-virtual-router/src',
]) {
  const joined = walkRust(rel).map(read).join('\n').toLowerCase();
  if (joined.includes('anyint')) failures.push(`${rel}: provider-specific anyint model mapping is forbidden in Hub/Virtual Router`);
}

const functionMap = parseYaml(files.functionMap);
const resourceMap = parseYaml(files.resourceMap);
const mainlineMap = parseYaml(files.mainlineMap);
const verificationMap = parseYaml(files.verificationMap);
const manifest = parseYaml(files.manifest);
const featureId = 'v3.route_selected_provider_model_binding';
const feature = (functionMap.features || []).find((row) => row.feature_id === featureId);
if (!feature || feature.status !== 'active') failures.push(`${files.functionMap}: ${featureId} must exist with status active`);
if (feature?.owner_file !== files.owner) failures.push(`${files.functionMap}: ${featureId} owner_file must be ${files.owner}`);
const resourceId = 'v3.request.selected_provider_model_bound';
const resource = (resourceMap.resources || []).find((row) => row.resource_id === resourceId);
if (!resource || resource.binding_status !== 'anchored') failures.push(`${files.resourceMap}: ${resourceId} must be anchored`);
if (resource?.allowed_writers?.length !== 1 || resource.allowed_writers[0] !== 'bind_v3_selected_provider_model') {
  failures.push(`${files.resourceMap}: ${resourceId} must have bind_v3_selected_provider_model as sole writer`);
}
const chain = (mainlineMap.chains || []).find((row) => row.chain_id === 'v3.selected_provider_model_binding');
if (!chain) failures.push(`${files.mainlineMap}: missing chain v3.selected_provider_model_binding`);
for (const stepId of ['v3-model-bind-01', 'v3-model-bind-02', 'v3-model-bind-03', 'v3-model-bind-04']) {
  if (!(chain?.edges || []).some((row) => row.step_id === stepId)) failures.push(`${files.mainlineMap}: missing ${stepId}`);
  requireText(text.manifest, files.manifest, stepId);
  requireText(text.wiki, files.wiki, stepId);
}
const verification = (verificationMap.features || []).find((row) => row.feature_id === featureId);
for (const gate of [
  'npm run verify:v3-selected-provider-model-binding',
  'npm run test:v3-selected-provider-model-binding-red-fixtures',
  'npm run verify:architecture-mainline-call-map',
  'npm run build:v3-cli',
]) {
  if (!(feature?.required_gates || []).includes(gate)) failures.push(`${files.functionMap}: ${featureId} missing required gate ${gate}`);
  if (!(verification?.required_gates || []).includes(gate)) failures.push(`${files.verificationMap}: ${featureId} missing required gate ${gate}`);
}
if (manifest.lifecycle_id !== 'v3.selected_provider_model_binding') failures.push(`${files.manifest}: lifecycle_id mismatch`);
if (manifest.owner_feature_id !== featureId) failures.push(`${files.manifest}: owner_feature_id mismatch`);
for (const token of ['Virtual Router remains payload-pure', 'Provider wire validates', 'Direct', 'Relay']) {
  requireText(text.wiki, files.wiki, token);
}

if (failures.length) {
  console.error('[verify:v3-selected-provider-model-binding] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-selected-provider-model-binding] ok');
console.log('- sole model-binding owner: selected_provider_model_binding.rs');
console.log('- Direct/Relay bind before compat/wire; Provider12 validates only');
console.log('- maps/manifest/wiki/build wiring: active');

function walkRust(rel) {
  const start = abs(rel);
  if (!fs.existsSync(start)) return [];
  const out = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(path.relative(root, full));
    }
  };
  visit(start);
  return out;
}
