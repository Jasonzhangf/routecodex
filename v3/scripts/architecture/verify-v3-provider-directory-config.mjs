#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const files = {
  owner: 'v3/crates/routecodex-v3-config/src/provider_directory.rs',
  codec: 'v3/crates/routecodex-v3-config/src/v2_compat.rs',
  tests: 'v3/crates/routecodex-v3-config/tests/provider_directory_config_contract.rs',
  functionMap: 'docs/architecture/v3-function-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.provider_directory_config.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-provider-directory-config.md',
  wikiHtml: 'docs/architecture/wiki/html/v3-provider-directory-config.html',
  design: 'docs/design/v3-provider-directory-config.md',
  testDesign: 'docs/goals/v3-provider-directory-config-test-design.md',
  packageJson: 'v3/package.json',
};

const absolute = (relative) => path.join(root, relative);
const read = (relative) => {
  try {
    return fs.readFileSync(absolute(relative), 'utf8');
  } catch (error) {
    failures.push(`${relative}: cannot read: ${error.message}`);
    return '';
  }
};
const requireText = (text, relative, token) => {
  if (!text.includes(token)) failures.push(`${relative}: missing ${token}`);
};
const parseYaml = (relative) => {
  try {
    return YAML.parse(read(relative));
  } catch (error) {
    failures.push(`${relative}: YAML parse failed: ${error.message}`);
    return {};
  }
};

for (const relative of Object.values(files)) {
  if (!fs.existsSync(absolute(relative))) failures.push(`${relative}: missing required file`);
}

const text = Object.fromEntries(Object.entries(files).map(([key, relative]) => [key, read(relative)]));
let packageJson = {};
try {
  packageJson = JSON.parse(text.packageJson);
} catch (error) {
  failures.push(`package.json: JSON parse failed: ${error.message}`);
}

for (const [name, command] of Object.entries({
  'test:v3-provider-directory-config': 'node scripts/run-v3-cargo-test.mjs -p routecodex-v3-config --test provider_directory_config_contract -- --nocapture',
  'test:v3-provider-directory-config-red-fixtures': 'node scripts/tests/v3-provider-directory-config-red-fixtures.mjs',
  'verify:v3-provider-directory-config': 'node scripts/architecture/verify-v3-provider-directory-config.mjs',
})) {
  if (packageJson.scripts?.[name] !== command) failures.push(`package.json: script ${name} must equal ${command}`);
}
if (!String(packageJson.scripts?.['verify:v3-architecture-docs'] || '').includes('npm run verify:v3-provider-directory-config')) {
  failures.push(`v3/package.json: verify:v3-architecture-docs must run npm run verify:v3-provider-directory-config`);
}
if (!String(packageJson.scripts?.['build:v3-cli'] || '').includes('npm run verify:v3-architecture-ci')) {
  failures.push('v3/package.json: build:v3-cli must enter the canonical V3 architecture gate');
}

requireText(text.owner, files.owner, 'feature_id: v3.provider_directory_config_compat');
requireText(text.owner, files.owner, 'resolve_v3_provider_directory_from_authoring');
requireText(text.owner, files.owner, 'native v3 config cannot mix inline providers with provider directory sources');
requireText(text.codec, files.codec, 'config_dir\n            .join("provider")\n            .join(provider_id)\n            .join("config.v2.toml")');
for (const forbidden of ['resolve_v2_provider_source_path', 'std::env::var_os("HOME")', '.join(".rcc")']) {
  if (text.codec.includes(forbidden)) failures.push(`${files.codec}: provider source must resolve exact sibling path, found ${forbidden}`);
}

for (const testName of [
  'native_v3_root_loads_referenced_provider_files',
  'provider_only_source_change_changes_snapshot_identity_and_manifest',
  'direct_route_provider_target_is_discovered_without_forwarder',
  'missing_referenced_provider_file_fails_before_manifest_publication',
  'partial_inline_and_directory_provider_sources_are_rejected',
  'provider_directory_identity_mismatch_is_rejected',
]) {
  requireText(text.tests, files.tests, `fn ${testName}()`);
}

const functionMap = parseYaml(files.functionMap);
const feature = functionMap.features?.find((entry) => entry.feature_id === 'v3.config_interpreter_contract');
if (!feature || !feature.allowed_paths?.includes('v3/crates/routecodex-v3-config')) {
  failures.push(`${files.functionMap}: v3.config_interpreter_contract must own the V3 Config crate`);
}
const mainlineMap = parseYaml(files.mainlineMap);
if (!mainlineMap.chains?.some((entry) => entry.chain_id === 'v3.config.compile')) {
  failures.push(`${files.mainlineMap}: missing canonical chain v3.config.compile`);
}
const manifest = parseYaml(files.manifest);
if (manifest.lifecycle_id !== 'v3.provider_directory_config.mainline') failures.push(`${files.manifest}: lifecycle_id mismatch`);
if (manifest.owner_feature_id !== 'v3.provider_directory_config_compat') failures.push(`${files.manifest}: owner_feature_id mismatch`);
requireText(text.resourceMap, files.resourceMap, 'resource_id: v3.config.file_source');
requireText(text.verificationMap, files.verificationMap, 'feature_id: v3.config_interpreter_contract');
requireText(text.wiki, files.wiki, 'No parse error causes a source-mode fallback.');
requireText(text.design, files.design, 'Partial inline/directory merging or silent source precedence.');
requireText(text.testDesign, files.testDesign, 'negative mixed-source fixture becomes green only when explicit source-mode rejection exists');

if (failures.length > 0) {
  console.error('[verify:v3-provider-directory-config] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-provider-directory-config] ok');
console.log('- exact sibling provider source, owner maps, tests, review surface, and build wiring locked');
