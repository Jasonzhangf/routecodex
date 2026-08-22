#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const failures = [];
const requiredGate = 'cargo +stable check --locked --manifest-path v3/Cargo.toml';
const verifierGate = 'npm run verify:v3-dependency-projection';
const redFixtureGate = 'npm run test:v3-dependency-projection-red-fixtures';

const registry = YAML.parse(readFileSync('docs/architecture/v3-build-tool-module-registry.yml', 'utf8'));
const module = registry?.modules?.find((entry) => entry.module_id === 'v3-cargo-dependency-projection');
if (!module) {
  failures.push('v3-cargo-dependency-projection module must exist in the module registry');
}
if (module?.owner_feature_id !== 'v3.build.dependency_projection') {
  failures.push('v3-cargo-dependency-projection must own feature_id v3.build.dependency_projection');
}
for (const ownedPath of [
  'v3/Cargo.lock',
  'v3/crates/routecodex-v3-admin/Cargo.toml',
  'scripts/architecture/verify-v3-dependency-projection.mjs',
  'scripts/tests/v3-dependency-projection-red-fixtures.mjs',
  'docs/architecture/manifests/v3.build.dependency_projection.mainline.yml',
]) {
  if (!(module?.owned_paths ?? []).includes(ownedPath)) {
    failures.push(`module registry must own ${ownedPath}`);
  }
}
if (!(module?.allowed_edges ?? []).includes('V3DependencyManifestTruth -> V3DependencyLockProjection')) {
  failures.push('module registry must register the dependency projection adjacent edge');
}
if (!(module?.resources ?? []).includes('v3.build.dependency_projection')) {
  failures.push('module registry must bind v3.build.dependency_projection as its resource');
}
for (const gate of [requiredGate, verifierGate, redFixtureGate, 'npm run verify:v3-resource-map', 'npm run verify:v3-module-boundaries']) {
  if (!(module?.required_gates ?? []).includes(gate)) {
    failures.push(`module registry must require ${gate}`);
  }
}

const manifest = YAML.parse(readFileSync('docs/architecture/manifests/v3.build.dependency_projection.mainline.yml', 'utf8'));
if (manifest?.status !== 'active' || manifest?.lifecycle_id !== 'v3.build.dependency_projection') {
  failures.push('dependency projection lifecycle manifest must be active');
}
if (!Array.isArray(manifest?.edges) || manifest.edges.length !== 1) {
  failures.push('dependency projection manifest must declare exactly one manifest-to-lock edge');
}
for (const gate of [requiredGate, verifierGate, redFixtureGate, 'npm run verify:v3-resource-map', 'npm run verify:v3-module-boundaries']) {
  if (!(manifest?.verification_gates ?? []).includes(gate)) {
    failures.push(`dependency projection manifest must require ${gate}`);
  }
}
const redFixturePath = 'scripts/tests/v3-dependency-projection-red-fixtures.mjs';
const redFixtureSource = readFileSync(redFixturePath, 'utf8');
if (!redFixtureSource.includes('v3.build.dependency_projection')) {
  failures.push('dependency projection red fixtures must exercise the registered semantic owner');
}
if (!redFixtureSource.includes('verify-v3-architecture-ci.mjs') || !redFixtureSource.includes('verify:v3-dependency-projection')) {
  failures.push('dependency projection red fixtures must exercise architecture CI wiring');
}

const adminManifest = readFileSync('v3/crates/routecodex-v3-admin/Cargo.toml', 'utf8');
if (!adminManifest.includes('name = "routecodex-v3-admin"')) {
  failures.push('routecodex-v3-admin manifest must remain the semantic admin dependency source');
}

const functionMap = YAML.parse(readFileSync('docs/architecture/v3-function-map.yml', 'utf8'));
const functionFeature = functionMap?.features?.find((feature) => feature.feature_id === 'v3.build.dependency_projection');
if (!functionFeature?.mainline_bindings?.includes('v3-dependency-projection-01')) {
  failures.push('function map must bind v3.build.dependency_projection to the projection mainline edge');
}
for (const ownedPath of [
  'scripts/architecture/verify-v3-dependency-projection.mjs',
  'scripts/tests/v3-dependency-projection-red-fixtures.mjs',
]) {
  if (!(functionFeature?.allowed_paths ?? []).includes(ownedPath)) {
    failures.push(`function map must allow ${ownedPath}`);
  }
}
for (const gate of [requiredGate, verifierGate, redFixtureGate, 'npm run verify:v3-resource-map', 'npm run verify:v3-module-boundaries']) {
  if (!(functionFeature?.required_gates ?? []).includes(gate)) {
    failures.push(`function map must require ${gate}`);
  }
}

const resourceMap = YAML.parse(readFileSync('docs/architecture/v3-resource-operation-map.yml', 'utf8'));
const resource = resourceMap?.resources?.find((entry) => entry.resource_id === 'v3.build.dependency_projection');
if (resource?.allowed_writers?.join(',') !== 'cargo') {
  failures.push('v3.build.dependency_projection must only allow cargo as writer');
}
const verificationMap = YAML.parse(readFileSync('docs/architecture/v3-verification-map.yml', 'utf8'));
const verificationFeature = verificationMap?.features?.find((feature) => feature.feature_id === 'v3.build.dependency_projection');
if (!verificationFeature) {
  failures.push('verification map must declare v3.build.dependency_projection feature');
}
for (const gate of [requiredGate, verifierGate, redFixtureGate, 'npm run verify:v3-resource-map', 'npm run verify:v3-module-boundaries']) {
  if (!(verificationFeature?.required_gates ?? []).includes(gate)) {
    failures.push(`verification map must require ${gate}`);
  }
}

const architectureCi = readFileSync('scripts/architecture/verify-v3-architecture-ci.mjs', 'utf8');
for (const gate of ['verify:v3-dependency-projection', 'test:v3-dependency-projection-red-fixtures']) {
  if (!architectureCi.includes(`'${gate}'`)) {
    failures.push(`architecture CI must invoke ${gate}`);
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
for (const script of ['verify:v3-dependency-projection', 'test:v3-dependency-projection-red-fixtures']) {
  if (!packageJson?.scripts?.[script]) {
    failures.push(`package.json must expose ${script}`);
  }
}

const mainlineMap = YAML.parse(readFileSync('docs/architecture/v3-mainline-call-map.yml', 'utf8'));
const dependencyChain = (mainlineMap?.chains ?? []).find((chain) => chain.chain_id === 'v3.build.dependency_projection');
if (!dependencyChain) {
  failures.push('mainline map must declare v3.build.dependency_projection chain');
}
const dependencyEdge = dependencyChain?.edges?.find((edge) => edge.step_id === 'v3-dependency-projection-01');
if (!dependencyEdge) {
  failures.push('mainline map must declare v3-dependency-projection-01 step');
}
if (dependencyEdge && dependencyEdge.status !== 'binding_pending') {
  failures.push('dependency projection mainline edge must be binding_pending until a real builder symbol exists');
}

const cargoMetadata = spawnSync('cargo', [
  'metadata',
  '--locked',
  '--no-deps',
  '--format-version',
  '1',
  '--manifest-path',
  'v3/Cargo.toml',
], { encoding: 'utf8' });
if (cargoMetadata.status !== 0) {
  failures.push(`Cargo metadata --locked failed: ${(cargoMetadata.stderr || '').trim()}`);
} else {
  try {
    const metadata = JSON.parse(cargoMetadata.stdout);
    const admin = metadata.packages?.find((entry) => entry.name === 'routecodex-v3-admin');
    if (!admin) failures.push('Cargo metadata must include routecodex-v3-admin');
    if (admin && !metadata.workspace_members?.includes(admin.id)) {
      failures.push('routecodex-v3-admin must be a Cargo workspace member');
    }
    const lock = readFileSync('v3/Cargo.lock', 'utf8');
    const lockedPackages = new Set([...lock.matchAll(/^name = "([^"]+)"$/gmu)].map((match) => match[1]));
    for (const workspaceMember of metadata.packages ?? []) {
      if (!lockedPackages.has(workspaceMember.name)) {
        failures.push(`Cargo.lock must contain workspace package ${workspaceMember.name}`);
      }
    }
  } catch (error) {
    failures.push(`Cargo metadata output is not JSON: ${error.message}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-dependency-projection] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-dependency-projection] ok');
