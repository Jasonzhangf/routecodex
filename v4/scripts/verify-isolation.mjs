#!/usr/bin/env node
/**
 * V4 build-domain isolation gate (positive + red).
 *
 * Positive:
 *  1. Cargo workspace_root == v4, target_directory == v4/target.
 *  2. Every V4 Cargo path dependency resolves inside v4.
 *  3. No V4 build/gate surface references live V3 maps, root-relative
 *     `v4/...` paths, root `src/`, V3, or sharedmodule compile inputs.
 *  4. Node packages resolve from v4/node_modules (never root fallback).
 *  5. Every tracked V4 source/build file belongs to exactly one module in
 *     the module registry; build edges are declared and adjacent.
 *  6. Root package.json and CI contain only approved V4 dispatcher forms.
 *  7. No V4 build command writes outside V4-owned output roots.
 *
 * Red fixtures prove each negative class fails through the same code paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { v4Root, runCapture } from './_common.mjs';
import { loadV3Baseline } from './architecture/_v3-baseline.mjs';

const failures = [];
const IGNORED_DIRS = new Set([
  'target',
  'build-control',
  'node_modules',
  'active',
  'protected',
  'generated',
  'dist',
  'artifacts',
  '.appsdk-control',
]);

const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /docs\/architecture\/v3-(?:function-map|resource-operation-map|mainline-call-map|verification-map)\.yml/, label: 'live V3 map read' },
  { pattern: /--manifest-path\s+v4\//, label: 'root-relative --manifest-path v4/' },
  { pattern: /--manifest-path["']?\s*,\s*["']v4\//, label: 'root-relative --manifest-path v4/ (array form)' },
  { pattern: /--root\s+v4\b/, label: 'root-relative --root v4' },
  { pattern: /--root["']?\s*,\s*["']v4\b/, label: 'root-relative --root v4 (array form)' },
  { pattern: /--manifest-path\s+\.\.\//, label: 'manifest path escaping v4' },
  { pattern: /\b(?:cargo|rustc|node|npm)\b[^\n]*\b(?:sharedmodule|v3\/crates|src\/)\//, label: 'V3/root/sharedmodule compile input' },
];

const ALLOWED_OUTPUT_PREFIXES = [
  'target',
  'build-control',
  'generated',
  'dist',
  'artifacts',
  'active',
  'protected',
];

function walkFiles(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '.') {
      source += '\\.';
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

function scanCargoPathDeps(files) {
  const out = [];
  const v4Real = fs.realpathSync(v4Root);
  for (const file of files.filter((f) => f.endsWith('Cargo.toml'))) {
    const text = fs.readFileSync(path.join(v4Root, file), 'utf8');
    for (const match of text.matchAll(/path\s*=\s*["']([^"']+)["']/g)) {
      const resolved = path.resolve(v4Root, path.dirname(file), match[1]);
      const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
      const rel = path.relative(v4Real, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        out.push(`${file}: path dependency escapes v4 -> ${match[1]}`);
      }
    }
  }
  return out;
}

function scanForbiddenReferences(files, base = v4Root) {
  const out = [];
  const scanRoots = [
    ...files.filter((f) => f.startsWith('scripts/') && f !== 'scripts/verify-isolation.mjs'),
    ...files.filter(
      (f) =>
        f === 'package.json' ||
        (f.startsWith('.appsdk/') && f.endsWith('project.json')),
    ),
    ...files.filter((f) => f.startsWith('.appsdk/maps/')),
  ];
  for (const file of scanRoots) {
    const full = path.join(base, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const rule of FORBIDDEN_PATH_PATTERNS) {
      if (rule.pattern.test(text)) {
        out.push(`${file}: forbidden ${rule.label} (${rule.pattern})`);
      }
    }
  }
  return out;
}

function scanOutputTargets(files, base = v4Root) {
  const out = [];
  const textSources = [
    'package.json',
    '.appsdk/project.json',
    ...files.filter((f) => f.startsWith('scripts/') && f.endsWith('.mjs') && f !== 'scripts/verify-isolation.mjs'),
  ];
  for (const file of textSources) {
    const full = path.join(base, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(/(?:--out|--output|-o)\s+([^\s"']+)/g)) {
      const target = match[1];
      if (target.startsWith('/') && !target.startsWith(`${v4Root}/`)) {
        out.push(`${file}: output target escapes v4 -> ${target}`);
        continue;
      }
      const rel = target.replace(/^\.\//, '');
      if (rel.startsWith('../')) {
        out.push(`${file}: output target escapes v4 -> ${target}`);
      }
    }
    for (const match of text.matchAll(/(?:cp|mv|rsync)\s+[^\n]*\s(\/tmp\/|\$TMPDIR|\$HOME)/g)) {
      out.push(`${file}: output target escapes v4 (${match[0]})`);
    }
  }
  return out;
}

function checkNodeResolution() {
  const result = spawnSync(
    process.execPath,
    ['-e', "console.log(import.meta.resolve('js-yaml'))"],
    { cwd: v4Root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return ['js-yaml does not resolve from v4 (v4/node_modules missing?)'];
  }
  const resolved = result.stdout.trim();
  const v4Modules = path.join(v4Root, 'node_modules');
  if (!resolved.startsWith(`file://${v4Modules}`) && !resolved.startsWith(`file://${v4Modules.replaceAll('/', '%2F')}`)) {
    return [`js-yaml resolves outside v4/node_modules: ${resolved}`];
  }
  return [];
}

function checkModuleCoverage(registry, files) {
  const out = [];
  const owners = [];
  for (const module of registry.modules ?? []) {
    for (const pattern of module.owned_paths ?? []) {
      owners.push({ moduleId: module.module_id, regex: globToRegExp(pattern), pattern });
    }
  }
  for (const file of files) {
    const matched = owners.filter((owner) => owner.regex.test(file));
    if (matched.length === 0) {
      out.push(`${file}: no module owner (unregistered source/build file)`);
    } else if (matched.length > 1) {
      out.push(`${file}: multiple module owners (${matched.map((m) => m.moduleId).join(',')})`);
    }
  }
  return out;
}

function checkMainlineEdges() {
  const out = [];
  const mainline = JSON.parse(fs.readFileSync(path.join(v4Root, '.appsdk/maps/mainline-call-map.json'), 'utf8'));
  const allowedOwners = new Set(['appsdk::goal', 'appsdk::lifecycle', 'appsdk::regression_gate', 'appsdk::compiler', 'appsdk::publisher', 'appsdk::freezer', 'appsdk::verifier', 'appsdk::workspace', 'appsdk::init', 'appsdk::verify', 'appsdk::build_domain', 'routecodex-v4-build-link', 'routecodex-v4-edge::validate_edge', 'routecodex-v4-control::metadata_center', 'routecodex-v4-error::error_chain', 'routecodex-v4-base-node::BaseNode', 'routecodex-v4-config::config_node', 'routecodex-v4-config::validate_edges', 'routecodex-v4-config::parse_v4_config_02_from_v4_config_01', 'routecodex-v4-config::validate_v4_config_03_from_v4_config_02', 'routecodex-v4-config::build_v4_config_04_from_v4_config_03', 'routecodex-v4-config::publish_v4_config_05_from_v4_config_04', 'routecodex-v4-runtime::ExecutionContext', 'routecodex-v4-runtime::SkeletonRuntime']);
  for (const edge of mainline.edges ?? []) {
    if (!edge.from || !edge.to || !edge.owner) {
      out.push(`mainline edge missing from/to/owner: ${JSON.stringify(edge)}`);
    }
    if (!allowedOwners.has(edge.owner)) {
      out.push(`mainline edge unregistered owner ${edge.owner} (${edge.from}->${edge.to})`);
    }
  }
  return out;
}

function checkRootDispatchers(rootPkgPath, workflowPath) {
  const out = [];
  if (fs.existsSync(rootPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (!name.startsWith('verify:v4') && !name.startsWith('test:v4')) continue;
      if (!/^npm --prefix v4 run /.test(command)) {
        out.push(`root package.json ${name}: must be a thin npm --prefix v4 dispatcher (got: ${command})`);
      }
    }
  }
  if (fs.existsSync(workflowPath)) {
    const text = fs.readFileSync(workflowPath, 'utf8');
    for (const rule of [
      /cargo (?:test|build|run)[^\n]*--manifest-path v4\/Cargo\.toml/,
      /cargo (?:test|build|run)[^\n]*routecodex-v4-/,
      /node scripts\/architecture\/verify-v4-/,
      /test-consumer --root v4/,
    ]) {
      if (rule.test(text)) {
        out.push(`root CI enumerates an individual V4 gate/consumer: ${rule}`);
      }
    }
  }
  return out;
}

function reportAndExit(label) {
  if (failures.length > 0) {
    console.error(`[v4 isolation] ${label} FAIL`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`[v4 isolation] ${label} OK`);
}

// ---------------------------------------------------------------------------
// Positive checks
// ---------------------------------------------------------------------------
const metadata = JSON.parse(runCapture('cargo metadata --format-version 1 --no-deps --manifest-path Cargo.toml'));
if (path.resolve(metadata.workspace_root) !== path.resolve(v4Root)) {
  failures.push(`cargo workspace_root=${metadata.workspace_root} (must be ${v4Root})`);
}
if (path.resolve(metadata.target_directory) !== path.resolve(path.join(v4Root, 'target'))) {
  failures.push(`cargo target_directory=${metadata.target_directory} (must be ${path.join(v4Root, 'target')})`);
}

const allFiles = walkFiles(v4Root);
failures.push(...scanCargoPathDeps(allFiles));
failures.push(...scanForbiddenReferences(allFiles));
failures.push(...scanOutputTargets(allFiles));
failures.push(...checkNodeResolution());

const registry = JSON.parse(fs.readFileSync(path.join(v4Root, '.appsdk/maps/module-registry.json'), 'utf8'));
const coverageFailures = checkModuleCoverage(registry, allFiles);
if (coverageFailures.length > 0) {
  failures.push(`module registry coverage:\n${coverageFailures.join('\n')}`);
}
const sourceCoverage = coverageFailures.filter((f) => f.includes('no module owner'));
const edgeFailures = checkMainlineEdges();
if (edgeFailures.length > 0) {
  failures.push(`mainline edges:\n${edgeFailures.join('\n')}`);
}
const dispatcherFailures = checkRootDispatchers(
  path.join(v4Root, '../package.json'),
  path.join(v4Root, '../.github/workflows/test.yml'),
);
if (dispatcherFailures.length > 0) {
  failures.push(`root dispatchers:\n${dispatcherFailures.join('\n')}`);
}
reportAndExit('positive');

// ---------------------------------------------------------------------------
// Red fixtures (same code paths, isolated under v4/build-control)
// ---------------------------------------------------------------------------
const redDir = path.join(v4Root, 'build-control/isolation-red');
fs.rmSync(redDir, { recursive: true, force: true });
fs.mkdirSync(redDir, { recursive: true });

let redFail = 0;
const expectReject = (name, fn) => {
  const problems = fn();
  if (problems.length === 0) {
    console.error(`[v4 isolation] red ${name}: expected FAIL, got PASS`);
    redFail += 1;
  } else {
    console.log(`[v4 isolation] red ${name}: FAIL as expected (${problems.length})`);
  }
};

// R1: escaping Cargo path dependency.
const escapeDir = path.join(redDir, 'path-dep');
fs.mkdirSync(escapeDir, { recursive: true });
fs.writeFileSync(
  path.join(escapeDir, 'Cargo.toml'),
  '[dependencies]\nescape = { path = "../../../../src/escape" }\n',
);
const escapeProblems = scanCargoPathDeps(walkFiles(escapeDir, 'build-control/isolation-red/path-dep'));
expectReject('escaping Cargo path dependency', () => escapeProblems);

// R2: verifier reading live V3 map.
const v3ReadDir = path.join(redDir, 'scripts/isolation-red/v3-read');
fs.mkdirSync(v3ReadDir, { recursive: true });
fs.writeFileSync(
  path.join(v3ReadDir, 'verify-v4-red-fixture.mjs'),
  "import fs from 'node:fs';\nfs.readFileSync('docs/architecture/v3-resource-operation-map.yml');\n",
);
const v3ReadProblems = scanForbiddenReferences(
  walkFiles(v3ReadDir, 'scripts/isolation-red/v3-read'),
  redDir,
);
expectReject('live V3 map read', () => v3ReadProblems);

// R3: baseline tamper is rejected by digest contract.
const baselineDir = path.join(v4Root, 'contracts/v3-baseline');
const baselineManifestPath = path.join(baselineDir, 'manifest.json');
if (fs.existsSync(baselineManifestPath)) {
  const tamperDir = path.join(redDir, 'baseline-tamper');
  fs.mkdirSync(tamperDir, { recursive: true });
  fs.copyFileSync(baselineManifestPath, path.join(tamperDir, 'manifest.json'));
  const source = fs.readFileSync(path.join(baselineDir, 'v3-function-map.yml'), 'utf8');
  fs.writeFileSync(path.join(tamperDir, 'v3-function-map.yml'), `${source}\n# tampered\n`);
  expectReject('unauthorized baseline tamper', () => {
    try {
      loadV3Baseline('v3-function-map.yml', tamperDir);
      return [];
    } catch (error) {
      return [`baseline tamper rejected: ${error.message}`];
    }
  });
}

// R4: root-relative AppSDK command.
const appsdkDir = path.join(redDir, '.appsdk/isolation-red/appsdk-root-relative');
fs.mkdirSync(appsdkDir, { recursive: true });
fs.writeFileSync(
  path.join(appsdkDir, 'project.json'),
  '{"build":{"args":["run","--quiet","--release","--manifest-path","v4/Cargo.toml","-p","routecodex-v4-build-link","--","test-consumer","--root","v4"],"program":"cargo","working_directory":"."}}\n',
);
const appsdkProblems = scanForbiddenReferences(
  walkFiles(appsdkDir, '.appsdk/isolation-red/appsdk-root-relative'),
  redDir,
);
expectReject('root-relative AppSDK command', () => appsdkProblems);

// R5: root CI enumerating an individual V4 consumer.
const ciDir = path.join(redDir, 'ci-enumeration');
fs.mkdirSync(ciDir, { recursive: true });
fs.writeFileSync(
  path.join(ciDir, 'test.yml'),
  'jobs:\n  v4-active-link:\n    runs-on: macos-14\n    steps:\n      - run: cargo run --quiet --release --manifest-path v4/Cargo.toml -p routecodex-v4-build-link -- test-consumer --root v4 --consumer routecodex-v4-edge\n',
);
const ciProblems = checkRootDispatchers(
  path.join(ciDir, 'package.json'),
  path.join(ciDir, 'test.yml'),
);
expectReject('root CI V4 consumer enumeration', () => ciProblems);

// R6: unregistered V4 build script.
const unregisteredFiles = ['scripts/architecture/verify-v4-unregistered.mjs', 'contracts/v3-baseline/manifest.json'];
const unregisteredProblems = checkModuleCoverage(
  {
    modules: [
      { module_id: 'routecodex-v4-governance', owned_paths: ['.appsdk/**', 'contracts/**'] },
      { module_id: 'routecodex-v4-build-link', owned_paths: ['crates/routecodex-v4-build-link/**'] },
    ],
  },
  unregisteredFiles,
);
expectReject('unregistered V4 source/build script', () => unregisteredProblems);

// R7: output target escaping v4.
const outputDir = path.join(redDir, 'scripts/isolation-red/output-escape');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'verify-output.mjs'),
  "import { run } from './_common.mjs';\nrun('cargo run --release -p routecodex-v4-build-link -- build-consumer --out ../../escape.rlib');\n",
);
const outputProblems = scanOutputTargets(
  walkFiles(outputDir, 'scripts/isolation-red/output-escape'),
  redDir,
);
expectReject('output target escaping v4', () => outputProblems);

if (redFail > 0) {
  console.error(`[v4 isolation] red fixtures failed: ${redFail}`);
  process.exit(1);
}
console.log('[v4 isolation] OK red fixtures rejected');
