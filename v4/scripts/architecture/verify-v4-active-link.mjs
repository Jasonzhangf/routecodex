#!/usr/bin/env node
/**
 * verify:v4-active-link
 *
 * Locks the V4 Active-only artifact linking contract for frozen-module
 * consumers (design ID V4-ACTIVE-LINK-001):
 * 1. Migrated consumers must NOT carry a Cargo path dependency on the frozen
 *    module; their consumption edge is the resolver-owned Active link surface.
 * 2. Transitional consumers may keep a registered source-path edge only while
 *    the registry records mode=source_path status=transitional.
 * 3. No V4 Cargo manifest may path-depend on playground/protected/generated/.appsdk.
 * 4. Maps must register the unique resolver owner, link surface resource,
 *    Active link edges, and resolver/forbidden-edge gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];
const v4 = root;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const registry = readJson('contracts/active-link/frozen-consumer-registry.json');
const project = readJson('.appsdk/project.json');
const resourceMap = readJson('.appsdk/maps/resource-map.json');
const functionMap = readJson('.appsdk/maps/function-map.json');
const mainline = readJson('.appsdk/maps/mainline-call-map.json');
const verification = readJson('.appsdk/maps/verification-map.json');

if (!registry || !project || !resourceMap || !functionMap || !mainline || !verification) {
  console.log(failures.join('\n'));
  process.exit(1);
}

const frozenModules = new Set(
  (project.modules ?? [])
    .filter((module) => module.stage === 'frozen')
    .map((module) => module.module_id),
);

for (const moduleId of registry.frozen_modules ?? []) {
  if (!frozenModules.has(moduleId)) {
    failures.push(`registry: frozen_modules lists ${moduleId} but project.json stage != frozen`);
  }
}

const readCargoToml = (consumer) => {
  try {
    return fs.readFileSync(path.join(v4, consumer.manifest_path), 'utf8');
  } catch (error) {
    failures.push(`registry: cannot read ${consumer.manifest_path}: ${error.message}`);
    return '';
  }
};

const pathDependency = (toml, moduleId) =>
  new RegExp(`^${moduleId}\\s*=\\s*\\{[^}]*path\\s*=`, 'm').test(toml);

for (const consumer of registry.consumers ?? []) {
  const toml = readCargoToml(consumer);
  if (!toml) continue;
  const hasPath = pathDependency(toml, consumer.dependency);
  if (consumer.mode === 'active_artifact') {
    if (hasPath) {
      failures.push(
        `migrated consumer ${consumer.consumer} still has Cargo path dependency on ${consumer.dependency}`,
      );
    }
  } else if (consumer.mode === 'source_path') {
    if (!hasPath) {
      failures.push(
        `transitional consumer ${consumer.consumer} lost registered source-path dependency on ${consumer.dependency}`,
      );
    }
  } else {
    failures.push(`registry: unknown mode ${consumer.mode} for ${consumer.consumer}`);
  }
}

// Enumerate every V4 Cargo manifest (module crates + workspace root), skipping
// build/runtime/generated zones. No manifest may path-depend on a forbidden
// root, and every V4-module path dependency must be registered in the frozen
// consumer registry.
const manifestPaths = [];
const walkManifests = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'Cargo.toml') {
      manifestPaths.push(path.join(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (
      [
        'target',
        'build-control',
        '.appsdk-control',
        'generated',
        'active',
        'protected',
        'playground',
        'node_modules',
      ].includes(entry.name)
    ) {
      continue;
    }
    walkManifests(path.join(dir, entry.name));
  }
};
walkManifests(v4);
for (const manifest of manifestPaths) {
  const toml = (() => {
    try {
      return fs.readFileSync(manifest, 'utf8');
    } catch {
      return '';
    }
  })();
  const relative = path.relative(root, manifest);
  for (const forbidden of registry.forbidden_path_roots ?? []) {
    if (new RegExp(`path\\s*=\\s*["'][^"']*${forbidden}`).test(toml)) {
      failures.push(`forbidden root path dependency on ${forbidden} in ${relative}`);
    }
  }
}
const registeredEdges = new Set(
  (registry.consumers ?? []).map((consumer) => `${consumer.consumer}->${consumer.dependency}`),
);
for (const manifest of manifestPaths) {
  const relativeToV4 = path.relative(v4, manifest);
  const consumerMatch = relativeToV4.match(/^crates\/([^/]+)\/Cargo\.toml$/);
  if (!consumerMatch) continue;
  const consumer = consumerMatch[1];
  const toml = (() => {
    try {
      return fs.readFileSync(manifest, 'utf8');
    } catch {
      return '';
    }
  })();
  const pathDeps = [...toml.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*path\s*=/gm)].map(
    (match) => match[1],
  );
  for (const dependency of pathDeps) {
    if (!registeredEdges.has(`${consumer}->${dependency}`)) {
      failures.push(
        `unregistered V4 path dependency ${consumer} -> ${dependency} in ${path.relative(root, manifest)}`,
      );
    }
  }
}

const edges = (mainline.edges ?? []).map((edge) => ({
  from: edge.from,
  to: edge.to,
  owner: edge.owner,
  edgeType: edge.edge_type,
  path: edge.path,
}));

if (!(resourceMap.resources ?? []).some((r) => r.resource_id === 'v4.build.link_surface')) {
  failures.push('resource map: missing v4.build.link_surface');
}
if (!(resourceMap.resources ?? []).some((r) => r.resource_id === 'v4.build.active_artifact_index')) {
  failures.push('resource map: missing v4.build.active_artifact_index');
}

const resolverFunctions = ['resolve_active_artifact', 'emit_link_flags'];
for (const fn of resolverFunctions) {
  const row = (functionMap.functions ?? []).find((f) => f.function_id === `v4.build_link.${fn}`);
  if (!row) {
    failures.push(`function map: missing v4.build_link.${fn}`);
  } else if (row.owner !== 'routecodex-v4-build-link') {
    failures.push(`function map: v4.build_link.${fn} owner must be routecodex-v4-build-link`);
  }
}

const migrated = (registry.consumers ?? []).filter((c) => c.mode === 'active_artifact');
for (const consumer of migrated) {
  const edge = edges.find(
    (e) =>
      e.from === consumer.consumer &&
      e.to === consumer.dependency &&
      e.edgeType === 'active_artifact_link' &&
      e.owner === 'routecodex-v4-build-link',
  );
  if (!edge) {
    failures.push(
      `mainline map: missing active_artifact_link edge ${consumer.consumer} -> ${consumer.dependency} (owner routecodex-v4-build-link)`,
    );
  }
}

const gates = (verification.gates ?? []).map((gate) => gate.gate_id);
for (const gate of ['v4_active_link_resolver', 'v4_frozen_source_edge_forbidden', 'v4_cargo_workspace_build']) {
  if (!gates.includes(gate)) {
    failures.push(`verification map: missing gate ${gate}`);
  }
}

if (failures.length > 0) {
  console.log(`V4_ACTIVE_LINK_GATE_FAIL\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('V4_ACTIVE_LINK_GATE_OK');
