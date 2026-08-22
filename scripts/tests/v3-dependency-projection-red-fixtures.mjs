#!/usr/bin/env node
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-dependency-projection.mjs');
const umbrella = resolve(repoRoot, 'scripts/architecture/verify-v3-architecture-ci.mjs');
const files = [
  'docs/architecture/v3-build-tool-module-registry.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.build.dependency_projection.mainline.yml',
  'scripts/architecture/verify-v3-architecture-ci.mjs',
  'package.json',
  'v3/Cargo.toml',
  'v3/Cargo.lock',
  'v3/crates/routecodex-v3-admin/Cargo.toml',
  'scripts/tests/v3-dependency-projection-red-fixtures.mjs',
];
const cases = [
  [
    'module registry drops dependency-projection owner',
    'docs/architecture/v3-build-tool-module-registry.yml',
    '  - module_id: v3-cargo-dependency-projection\n',
    '',
  ],
  [
    'module registry drops dependency-projection verifier path',
    'docs/architecture/v3-build-tool-module-registry.yml',
    '  - scripts/architecture/verify-v3-dependency-projection.mjs\n',
    '',
  ],
  [
    'module registry drops dependency-projection edge',
    'docs/architecture/v3-build-tool-module-registry.yml',
    '  - V3DependencyManifestTruth -> V3DependencyLockProjection\n',
    '',
  ],
  [
    'module registry drops dependency-projection resource',
    'docs/architecture/v3-build-tool-module-registry.yml',
    '  - v3.build.dependency_projection\n',
    '',
  ],
  [
    'function map drops dependency-projection feature',
    'docs/architecture/v3-function-map.yml',
    '- feature_id: v3.build.dependency_projection\n',
    '',
  ],
  [
    'function map drops dependency-projection mainline binding',
    'docs/architecture/v3-function-map.yml',
    '  - v3-dependency-projection-01\n',
    '',
  ],
  [
    'resource map drops dependency-projection resource',
    'docs/architecture/v3-resource-operation-map.yml',
    '  - resource_id: v3.build.dependency_projection\n',
    '',
  ],
  [
    'verification map drops dependency-projection verifier gate',
    'docs/architecture/v3-verification-map.yml',
    '  - npm run verify:v3-dependency-projection\n',
    '',
  ],
  [
    'verification map drops dependency-projection red-fixture gate',
    'docs/architecture/v3-verification-map.yml',
    '  - npm run test:v3-dependency-projection-red-fixtures\n',
    '',
  ],
  [
    'mainline map drops dependency-projection chain',
    'docs/architecture/v3-mainline-call-map.yml',
    '- chain_id: v3.build.dependency_projection\n',
    '',
  ],
  [
    'lifecycle manifest drops verifier gate',
    'docs/architecture/manifests/v3.build.dependency_projection.mainline.yml',
    '  - npm run verify:v3-dependency-projection\n',
    '',
  ],
  [
    'architecture CI drops dependency-projection gate',
    'scripts/architecture/verify-v3-architecture-ci.mjs',
    "  ['verify:v3-dependency-projection', 'V3 Cargo workspace dependency projection is owned and lockfile-bound'],\n",
    '',
  ],
  [
    'package.json drops dependency-projection gate',
    'package.json',
    '    "verify:v3-dependency-projection": "node scripts/architecture/verify-v3-dependency-projection.mjs",\n',
    '',
  ],
  [
    'Cargo.lock drops the admin package projection',
    'v3/Cargo.lock',
    'name = "routecodex-v3-admin"\n',
    'name = "routecodex-v3-admin-stale"\n',
  ],
];

function cargoSources(root, result = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      if (stat.isFile()) result.push(path);
      continue;
    }
    if (entry === 'target' || entry === 'node_modules' || entry === '.git') continue;
    cargoSources(path, result);
  }
  return result;
}

const failures = [];
for (const [name, file, from, to] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-dependency-projection-red-'));
  try {
    for (const source of files) {
      const target = resolve(root, source);
      mkdirSync(join(target, '..'), { recursive: true });
      cpSync(resolve(repoRoot, source), target);
    }
    for (const sourceRoot of ['v3', 'sharedmodule/llmswitch-core/rust-core']) {
      for (const source of cargoSources(resolve(repoRoot, sourceRoot))) {
        if (!source.endsWith('.rs') && !source.endsWith('.toml')) continue;
        const relative = source.slice(repoRoot.length + 1);
        const target = resolve(root, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        cpSync(source, target);
      }
    }
    mkdirSync(resolve(root, 'node_modules'), { recursive: true });
    let yamlResolved = false;
    for (const candidate of [
      resolve(repoRoot, 'node_modules/yaml'),
      resolve(repoRoot, '..', 'node_modules/yaml'),
      resolve(repoRoot, '..', '..', 'node_modules/yaml'),
    ]) {
      try {
        if (statSync(resolve(candidate, 'package.json')).isFile()) {
          cpSync(candidate, resolve(root, 'node_modules/yaml'), { recursive: true });
          yamlResolved = true;
          break;
        }
      } catch {}
    }
    if (!yamlResolved) throw new Error('fixture requires the yaml package to be installed in repo or parent node_modules');
    const baseline = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    if (baseline.status !== 0) {
      throw new Error(`${name}: isolated baseline failed: ${baseline.stderr || baseline.stdout}`);
    }
    const target = resolve(root, file);
    if (file === 'package.json') {
      const pkg = JSON.parse(readFileSync(target, 'utf8'));
      delete pkg.scripts['verify:v3-dependency-projection'];
      writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`);
    } else {
      const text = readFileSync(target, 'utf8');
      if (!text.includes(from)) throw new Error(`${name}: mutation source missing`);
      writeFileSync(target, text.replaceAll(from, to));
    }
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-dependency-projection-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-dependency-projection-red-fixtures] ok (${cases.length} mutations rejected)`);
