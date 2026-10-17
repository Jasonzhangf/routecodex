#!/usr/bin/env node
// Red fixture for verify-v3-module-boundaries.mjs.
//
// Every case runs the real verifier against minimal declared data: a small
// crate file set, the real function maps, a minimal runtime module registry and
// a minimal build module registry, plus minimal Cargo manifests for the
// declared dependency contracts. No case copies the v3/ crate source tree.
//
// The cases below mutate declared ownership data. Source-text, symbol-spelling
// and private-implementation mutation cases were retired with the source-lock
// ablation and are intentionally absent.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(v3Root, '..');
const verifier = resolve(v3Root, 'scripts/architecture/verify-v3-module-boundaries.mjs');

const crateSourceFiles = [
  'v3/crates/routecodex-v3-runtime/src/lib.rs',
  'v3/crates/routecodex-v3-target/src/lib.rs',
  'v3/crates/routecodex-v3-virtual-router/src/lib.rs',
];

// Minimal runtime registry: every staged crate file stays owned exactly once.
const runtimeRegistry = `version: 1
status: active
source_root: v3/crates
modules:
  - module_id: v3.runtime
    owner_feature_id: v3.hub_pipeline_static_skeleton
    owned_paths:
      - v3/crates/routecodex-v3-runtime/**
  - module_id: v3.target
    owner_feature_id: v3.virtual_router_target_interpreter
    owned_paths:
      - v3/crates/routecodex-v3-target/**
  - module_id: v3.virtual_router
    owner_feature_id: v3.virtual_router_target_interpreter
    owned_paths:
      - v3/crates/routecodex-v3-virtual-router/**
  - module_id: v3.cli
    owner_feature_id: v3.managed_server_lifecycle
    owned_paths:
      - v3/crates/routecodex-v3-cli/**
  - module_id: v3.server
    owner_feature_id: v3.managed_server_lifecycle
    owned_paths:
      - v3/crates/routecodex-v3-server/**
`;

// Minimal build registry: it owns build tooling paths and references exactly one
// runtime module for each referenced crate path.
const buildRegistry = `version: 1
status: active
modules:
  - module_id: v3.build_tooling
    owner_feature_id: v3.build_test_artifact_budget
    owned_paths:
      - v3/Cargo.toml
    referenced_paths:
      - v3/crates/routecodex-v3-runtime/**
      - v3/crates/routecodex-v3-target/**
`;

const cargoManifests = {
  'v3/crates/routecodex-v3-runtime/Cargo.toml': `[package]
name = "routecodex-v3-runtime"
version = "0.1.0"

[dependencies]
routecodex-v3-provider-responses = { path = "../routecodex-v3-provider-responses" }
`,
  'v3/crates/routecodex-v3-target/Cargo.toml': `[package]
name = "routecodex-v3-target"
version = "0.1.0"

[dependencies]
routecodex-v3-config = { path = "../routecodex-v3-config" }
`,
  'v3/crates/routecodex-v3-server/Cargo.toml': `[package]
name = "routecodex-v3-server"
version = "0.1.0"

[dependencies]
axum.workspace = true
routecodex-v3-cli = { path = "../routecodex-v3-cli" }
routecodex-v3-runtime = { path = "../routecodex-v3-runtime" }

[dev-dependencies]
reqwest.workspace = true
`,
  'v3/crates/routecodex-v3-cli/Cargo.toml': `[package]
name = "routecodex-v3-cli"
version = "0.1.0"

[dependencies]
clap.workspace = true
routecodex-v3-config = { path = "../routecodex-v3-config" }
routecodex-v3-server = { path = "../routecodex-v3-server" }

[[bin]]
name = "rccv3"
path = "src/main.rs"
`,
  'v3/crates/routecodex-v3-virtual-router/Cargo.toml': `[package]
name = "routecodex-v3-virtual-router"
version = "0.1.0"

[dependencies]
routecodex-v3-route-classifier = { path = "../routecodex-v3-route-classifier" }
routecodex-v3-config = { path = "../routecodex-v3-config" }
thiserror.workspace = true
`,
};

const declaredInputs = [
  ['docs/architecture/v3-runtime-module-registry.yml', runtimeRegistry],
  ['docs/architecture/v3-build-tool-module-registry.yml', buildRegistry],
  ...Object.entries(cargoManifests),
];

// Runtime crate source stays irrelevant to this gate; only membership matters.
const stagedRust = 'pub fn declared_module_boundary_source() {}\n';

// Feature binding stays bound to the real declared function maps.
const declaredFunctionMaps = [
  'v3-function-map.yml',
  'function-map.yml',
];

const fixtures = [
  {
    name: 'runtime source loses its module owner',
    file: 'docs/architecture/v3-runtime-module-registry.yml',
    transform: (source) => source.replace('      - v3/crates/routecodex-v3-runtime/**\n', ''),
    diagnostic: /source must have exactly one module owner: v3\/crates\/routecodex-v3-runtime.*owners=none/,
  },
  {
    name: 'target source gains a duplicate module owner',
    file: 'docs/architecture/v3-runtime-module-registry.yml',
    transform: (source) => source.replace(
      '  - module_id: v3.virtual_router',
      '  - module_id: v3.target_duplicate\n    owner_feature_id: v3.virtual_router_target_interpreter\n    owned_paths:\n      - v3/crates/routecodex-v3-target/**\n  - module_id: v3.virtual_router',
    ),
    diagnostic: /source must have exactly one module owner: v3\/crates\/routecodex-v3-target.*v3\.target,v3\.target_duplicate/,
  },
  {
    name: 'build registry claims runtime source ownership',
    file: 'docs/architecture/v3-build-tool-module-registry.yml',
    transform: (source) => source.replace(
      '    owned_paths:\n      - v3/Cargo.toml\n',
      '    owned_paths:\n      - v3/Cargo.toml\n      - v3/crates/routecodex-v3-target/**\n',
    ),
    diagnostic: /source ownership overlaps build\/runtime registries: v3\/crates\/routecodex-v3-target.*owners=v3\.build_tooling,v3\.target/,
  },
  {
    name: 'build reference resolves to no runtime module owner',
    file: 'docs/architecture/v3-build-tool-module-registry.yml',
    transform: (source) => source.replace(
      '      - v3/crates/routecodex-v3-target/**\n',
      '      - v3/crates/routecodex-v3-undeclared-crate/**\n',
    ),
    diagnostic: /build reference must resolve to exactly one runtime module owner: v3\/crates\/routecodex-v3-undeclared-crate.*owners=none/,
  },
  {
    name: 'build reference resolves to multiple runtime module owners',
    file: 'docs/architecture/v3-build-tool-module-registry.yml',
    transform: (source) => source.replace(
      '      - v3/crates/routecodex-v3-runtime/**\n',
      '      - v3/crates/**\n',
    ),
    diagnostic: /build reference must resolve to exactly one runtime module owner: v3\/crates.*owners=v3\.runtime,v3\.target,v3\.virtual_router/,
  },
  {
    name: 'module owner feature is undeclared',
    file: 'docs/architecture/v3-runtime-module-registry.yml',
    transform: (source) => source.replace('    owner_feature_id: v3.hub_pipeline_static_skeleton\n', '    owner_feature_id: v3.undeclared_feature\n'),
    diagnostic: /owner_feature_id does not resolve to a declared feature: v3\.undeclared_feature/,
  },
  {
    name: 'module entry drops owned paths',
    file: 'docs/architecture/v3-runtime-module-registry.yml',
    transform: (source) => source.replace('  - module_id: v3.virtual_router\n    owner_feature_id: v3.virtual_router_target_interpreter\n    owned_paths:\n      - v3/crates/routecodex-v3-virtual-router/**\n', '  - module_id: v3.virtual_router\n    owner_feature_id: v3.virtual_router_target_interpreter\n'),
    diagnostic: /module v3\.virtual_router requires owned_paths/,
  },
  {
    name: 'undeclared crate source is still unowned',
    insertFile: 'v3/crates/routecodex-v3-undeclared/src/lib.rs',
    diagnostic: /source must have exactly one module owner: v3\/crates\/routecodex-v3-undeclared.*owners=none/,
  },
  {
    name: 'server production dependencies include provider crate',
    file: 'v3/crates/routecodex-v3-server/Cargo.toml',
    transform: (source) => source.replace(
      'routecodex-v3-runtime = { path = "../routecodex-v3-runtime" }\n',
      'routecodex-v3-runtime = { path = "../routecodex-v3-runtime" }\nroutecodex-v3-provider-responses = { path = "../routecodex-v3-provider-responses" }\n',
    ),
    diagnostic: /server crate production dependencies must not include provider crate/,
  },
  {
    name: 'cli dependencies include provider crate',
    file: 'v3/crates/routecodex-v3-cli/Cargo.toml',
    transform: (source) => source.replace(
      'routecodex-v3-server = { path = "../routecodex-v3-server" }\n',
      'routecodex-v3-server = { path = "../routecodex-v3-server" }\nroutecodex-v3-provider-responses = { path = "../routecodex-v3-provider-responses" }\n',
    ),
    diagnostic: /CLI must not depend on provider transport directly/,
  },
  {
    name: 'virtual router dependencies include provider crate',
    file: 'v3/crates/routecodex-v3-virtual-router/Cargo.toml',
    transform: (source) => source.replace(
      'routecodex-v3-config = { path = "../routecodex-v3-config" }\n',
      'routecodex-v3-config = { path = "../routecodex-v3-config" }\nroutecodex-v3-provider-responses = { path = "../routecodex-v3-provider-responses" }\n',
    ),
    diagnostic: /virtual router cannot depend on provider transport, health or availability/,
  },
];

const failures = [];

function stageDeclaredInput(root, { mutate = null } = {}) {
  for (const [relativePath, content] of declaredInputs) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mutate ? mutate(relativePath, content) : content);
  }
  for (const name of declaredFunctionMaps) {
    copyFileSync(resolve(repoRoot, `docs/architecture/${name}`), join(root, `docs/architecture/${name}`));
  }
  for (const relativePath of crateSourceFiles) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stagedRust);
  }
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
    encoding: 'utf8',
  });
}

// Baseline: the minimal declared inputs must be GREEN before any mutation.
{
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-module-boundary-'));
  try {
    stageDeclaredInput(root);
    const result = runVerifier(root);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 0) {
      failures.push(`baseline: gate unexpectedly failed: ${output.slice(-2000)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-module-boundary-'));
  try {
    stageDeclaredInput(root, {
      mutate: (relativePath, content) => fixture.transform && relativePath === fixture.file
        ? fixture.transform(content)
        : content,
    });
    if (fixture.insertFile) {
      const target = join(root, fixture.insertFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, stagedRust);
    }
    const result = runVerifier(root);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1000)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-source-gate-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-source-gate-red-fixtures] ok (${declaredInputs.length + crateSourceFiles.length} declared inputs staged, baseline GREEN, ${fixtures.length} ownership/dependency mutations rejected)`);
