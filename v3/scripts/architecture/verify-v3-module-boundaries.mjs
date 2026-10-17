#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Declared-data module boundary gate.
//
// This gate validates the declared ownership data for V3 runtime modules:
// actual crate source membership, unique runtime-module ownership, declared
// feature binding, build/runtime ownership separation, unique runtime owner for
// each build reference, and crate dependency contracts read from real Cargo
// manifests. It deliberately does not scan Rust source text for symbol
// spelling, function names, call ordering or literal payload strings: those
// locks asserted source shape rather than independently justified ownership or
// dependency behavior and have been retired. Runtime behavior, security and
// consumer guarantees remain owned by the Rust tests under v3/crates.

const installedV3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const explicitSourceRoot = String(process.env.ROUTECODEX_V3_SOURCE_ROOT ?? '').trim();
const sourceRoot = explicitSourceRoot
  ? resolve(explicitSourceRoot)
  : resolve(installedV3Root, '..');
const v3Root = explicitSourceRoot
  ? resolve(sourceRoot, 'v3')
  : installedV3Root;
const resolveV3Path = (path) => path.startsWith('v3/')
  ? resolve(v3Root, path.slice(3))
  : resolve(sourceRoot, path);

const failures = [];

function files(dir, out = []) {
  const resolvedDir = resolveV3Path(dir);
  for (const entry of readdirSync(resolvedDir)) {
    const path = join(resolvedDir, entry);
    if (path.includes('/target/') || path.endsWith('/target')) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      throw new Error(`V3 module-boundary source disappeared during scan: ${path}`, { cause: error });
    }
    if (stat.isDirectory()) files(path, out);
    else if (path.endsWith('.rs') || path.endsWith('Cargo.toml')) out.push(path);
  }
  return out;
}

function fail(message) {
  failures.push(message);
}

function readDeclaredYaml(declaredPath) {
  let document;
  try {
    document = YAML.parse(readFileSync(resolveV3Path(declaredPath), 'utf8'));
  } catch (error) {
    fail(`${declaredPath}: declared YAML is not parseable: ${error.message}`);
    return null;
  }
  return document ?? null;
}

const all = files('v3/crates');
const read = (path) => readFileSync(resolveV3Path(path), 'utf8');
const moduleRegistryPath = 'docs/architecture/v3-runtime-module-registry.yml';
const buildModuleRegistryPath = 'docs/architecture/v3-build-tool-module-registry.yml';
const functionMapPaths = ['docs/architecture/v3-function-map.yml', 'docs/architecture/function-map.yml'];

// --- Declared feature binding -------------------------------------------

const declaredFeatureIds = new Set();
for (const functionMapPath of functionMapPaths) {
  const functionMap = readDeclaredYaml(functionMapPath);
  if (functionMap === null) continue;
  const features = Array.isArray(functionMap)
    ? functionMap
    : Array.isArray(functionMap?.features)
      ? functionMap.features
      : Array.isArray(functionMap?.owners)
        ? functionMap.owners
        : null;
  if (!features) {
    fail(`${functionMapPath} must contain a feature array`);
    continue;
  }
  for (const feature of features) {
    if (typeof feature?.feature_id === 'string' && feature.feature_id.trim()) {
      declaredFeatureIds.add(feature.feature_id.trim());
    }
  }
}

// --- Runtime module registry --------------------------------------------

const moduleRegistry = readDeclaredYaml(moduleRegistryPath);
let runtimeOwners = [];
if (moduleRegistry === null) {
  fail(`${moduleRegistryPath} must contain an active modules array`);
} else if (moduleRegistry?.status !== 'active' || !Array.isArray(moduleRegistry.modules)) {
  fail(`${moduleRegistryPath} must contain an active modules array`);
} else {
  const modules = moduleRegistry.modules;
  runtimeOwners = modules.flatMap((module) =>
    (module.owned_paths ?? []).map((path) => ({ module_id: module.module_id, path })));
  for (const path of all) {
    const repoPath = `v3/${relative(v3Root, path).split('\\').join('/')}`;
    const owners = modules.filter((module) => Array.isArray(module.owned_paths)
      && module.owned_paths.some((ownedPath) => {
        if (typeof ownedPath !== 'string') return false;
        if (ownedPath.endsWith('/**')) return repoPath.startsWith(ownedPath.slice(0, -3));
        return repoPath === ownedPath;
      }));
    if (owners.length !== 1) {
      fail(`V3 source must have exactly one module owner: ${repoPath} owners=${owners.map((owner) => owner.module_id).join(',') || 'none'}`);
    }
  }
  for (const module of modules) {
    if (typeof module.module_id !== 'string' || typeof module.owner_feature_id !== 'string') {
      fail(`${moduleRegistryPath} module entries require module_id and owner_feature_id`);
    } else if (!declaredFeatureIds.has(module.owner_feature_id)) {
      fail(`${moduleRegistryPath} module ${module.module_id} owner_feature_id does not resolve to a declared feature: ${module.owner_feature_id}`);
    }
    if (!Array.isArray(module.owned_paths) || module.owned_paths.length === 0) {
      fail(`${moduleRegistryPath} module ${module.module_id ?? '<unknown>'} requires owned_paths`);
    }
  }
}

// --- Build / runtime ownership separation -------------------------------

const buildModuleRegistry = readDeclaredYaml(buildModuleRegistryPath);
if (buildModuleRegistry === null) {
  fail(`${buildModuleRegistryPath} must contain an active modules array`);
} else if (buildModuleRegistry?.status !== 'active' || !Array.isArray(buildModuleRegistry.modules)) {
  fail(`${buildModuleRegistryPath} must contain an active modules array`);
} else if (Array.isArray(moduleRegistry?.modules)) {
  const pathRoot = (path) => path.endsWith('/**') ? path.slice(0, -3) : path;
  const pathsOverlap = (left, right) => {
    const leftRoot = pathRoot(left);
    const rightRoot = pathRoot(right);
    return leftRoot === rightRoot
      || leftRoot.startsWith(`${rightRoot}/`)
      || rightRoot.startsWith(`${leftRoot}/`);
  };
  for (const module of buildModuleRegistry.modules) {
    for (const ownedPath of module.owned_paths ?? []) {
      for (const runtimeOwner of runtimeOwners) {
        if (pathsOverlap(ownedPath, runtimeOwner.path)) {
          fail(`V3 source ownership overlaps build/runtime registries: ${ownedPath} owners=${module.module_id},${runtimeOwner.module_id}`);
        }
      }
    }
    for (const referencedPath of module.referenced_paths ?? []) {
      const owners = runtimeOwners.filter((owner) => pathsOverlap(referencedPath, owner.path));
      if (owners.length !== 1) {
        fail(`V3 build reference must resolve to exactly one runtime module owner: ${referencedPath} owners=${owners.map((owner) => owner.module_id).join(',') || 'none'}`);
      }
    }
  }
}

// --- Declared crate dependency contract --------------------------------

// Each entry is an independently justified ownership boundary between the
// crates named by the real Cargo manifests, read as structured data below.
const declaredDependencyContracts = [
  {
    name: 'server production dependencies',
    manifest: 'v3/crates/routecodex-v3-server/Cargo.toml',
    section: 'dependencies',
    forbiddenDependencies: ['routecodex-v3-provider-responses'],
    diagnostic: 'server crate production dependencies must not include provider crate',
  },
  {
    name: 'cli dependencies',
    manifest: 'v3/crates/routecodex-v3-cli/Cargo.toml',
    section: 'dependencies',
    forbiddenDependencies: ['routecodex-v3-provider-responses'],
    diagnostic: 'CLI must not depend on provider transport directly',
  },
  {
    name: 'virtual router dependencies',
    manifest: 'v3/crates/routecodex-v3-virtual-router/Cargo.toml',
    section: 'dependencies',
    forbiddenDependencies: ['routecodex-v3-provider-responses'],
    diagnostic: 'virtual router cannot depend on provider transport, health or availability',
  },
];

function declaredDependencyNames(section) {
  const names = [];
  for (const line of section.split('\n')) {
    const declaration = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (!declaration) continue;
    const name = declaration[1].endsWith('.workspace')
      ? declaration[1].slice(0, -'.workspace'.length)
      : declaration[1];
    names.push(name);
  }
  return names;
}

function declaredSection(source, sectionName) {
  const header = `[${sectionName}]`;
  for (const line of source.split('\n')) {
    if (line.trim() === header) {
      const start = source.indexOf(line);
      let end = source.indexOf('\n[', start + 1);
      if (end < 0) end = source.length;
      return source.slice(start + line.length, end);
    }
  }
  return '';
}

for (const contract of declaredDependencyContracts) {
  let manifest;
  try {
    manifest = read(contract.manifest);
  } catch (error) {
    fail(`${contract.manifest}: declared Cargo manifest is not readable: ${error.message}`);
    continue;
  }
  const section = declaredSection(manifest, contract.section);
  const dependencies = declaredDependencyNames(section);
  for (const forbidden of contract.forbiddenDependencies) {
    if (dependencies.includes(forbidden)) {
      fail(`${contract.diagnostic}: ${contract.manifest} ${contract.section} declares ${forbidden}`);
    }
  }
}

if (failures.length) {
  console.error('[verify:v3-module-boundaries] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-module-boundaries] ok');
