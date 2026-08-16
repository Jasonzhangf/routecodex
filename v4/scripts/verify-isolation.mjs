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
 *  6. Root package.json and CI contain only approved V4 dispatcher forms,
 *     and the CI job running V4 canonical verification is on an arm64 macOS
 *     runner matching the aarch64-apple-darwin Active artifact target
 *     (GitHub-hosted `macos-14` is ARM64 per the 2025-09-19 hosted-runner
 *     label change; Intel labels such as `macos-14-large`/`macos-15-intel`
 *     are rejected).
 *  7. The architecture gate/consumer matrix executed by verify/verify:red is
 *     exactly the matrix declared in verification-map.json (no drift in
 *     either direction).
 *  8. No V4 build command writes outside V4-owned output roots.
 *
 * Red fixtures prove each negative class fails through the same code paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { v4Root, runCapture } from './_common.mjs';
import { ARCHITECTURE_GATES, RED_SUITES, CONSUMER_REGRESSIONS } from './_gate-matrix.mjs';
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

function escapeViolation(target) {
  const stripped = target.replace(/^["']|["']$/g, '');
  if (stripped.startsWith('/') && !stripped.startsWith(`${v4Root}/`)) {
    return true;
  }
  const rel = stripped.replace(/^\.\//, '');
  return rel.startsWith('../');
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
    for (const match of text.matchAll(
      /(?:--out|--output|-o)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g,
    )) {
      const target = match[1] ?? match[2] ?? match[3];
      if (target && escapeViolation(target)) {
        out.push(`${file}: output target escapes v4 -> ${match[0]}`);
      }
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/\b(?:cp|mv|rsync)\b/.test(line)) continue;
      const tokens = line.trim().split(/\s+/);
      const destination = tokens[tokens.length - 1];
      if (destination && escapeViolation(destination)) {
        out.push(`${file}: output target escapes v4 -> ${line.trim()}`);
      } else if (/(\/tmp\/|\$TMPDIR|\$HOME)/.test(line)) {
        out.push(`${file}: output target escapes v4 (${line.trim()})`);
      }
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
  const allowedOwners = new Set(['appsdk::goal', 'appsdk::lifecycle', 'appsdk::regression_gate', 'appsdk::compiler', 'appsdk::publisher', 'appsdk::freezer', 'appsdk::verifier', 'appsdk::workspace', 'appsdk::init', 'appsdk::verify', 'appsdk::build_domain', 'routecodex-v4-build-link', 'routecodex-v4-edge::validate_edge', 'routecodex-v4-control::metadata_center', 'routecodex-v4-error::error_chain', 'routecodex-v4-base-node::BaseNode', 'routecodex-v4-config::config_node', 'routecodex-v4-config::validate_edges', 'routecodex-v4-config::parse_v4_config_02_from_v4_config_01', 'routecodex-v4-config::validate_v4_config_03_from_v4_config_02', 'routecodex-v4-config::build_v4_config_04_from_v4_config_03', 'routecodex-v4-config::publish_v4_config_05_from_v4_config_04', 'routecodex-v4-runtime::ExecutionContext', 'routecodex-v4-runtime::SkeletonRuntime', 'routecodex-v4-plugin-plan::compile_node_plan', 'routecodex-v4-plugin-catalog::register', 'routecodex-v4-cordis-bridge::compile_node', 'routecodex-v4-cordis-bridge::execute_plan']);
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

function checkRootDispatchers(rootPkgPath, workflowPath, v4PkgPath) {
  const out = [];
  const v4Pkg = fs.existsSync(v4PkgPath)
    ? JSON.parse(fs.readFileSync(v4PkgPath, 'utf8'))
    : {};
  if (fs.existsSync(rootPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (!name.startsWith('verify:v4') && !name.startsWith('test:v4') && !name.startsWith('build:v4')) continue;
      if (!/^npm --prefix v4 run /.test(command)) {
        out.push(`root package.json ${name}: must be a thin npm --prefix v4 dispatcher (got: ${command})`);
        continue;
      }
      if (/^(?:verify|test|build):v4-/.test(name)) {
        if (command !== `npm --prefix v4 run ${name}`) {
          out.push(`root package.json ${name}: dispatcher target must match its name (expected "npm --prefix v4 run ${name}", got: ${command})`);
        }
        if (!(v4Pkg.scripts ?? {})[name]) {
          out.push(`root package.json ${name}: v4/package.json has no matching script "${name}"`);
        }
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

/**
 * GitHub-hosted runner label semantics (verified 2026-08-16):
 * - ARM64 (Apple silicon) labels: macos-14, macos-15, macos-latest,
 *   macos-14-xlarge, macos-15-xlarge, macos-latest-xlarge.
 * - x86_64 (Intel) labels: macos-14-large, macos-15-intel,
 *   macos-latest-large, macos-15-large.
 * Source: https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/
 * The V4 canonical verify:ci job must run on an arm64 macOS runner because
 * the hermetic Active fixtures are aarch64-apple-darwin rlibs. xlarge labels
 * are paid larger runners and are intentionally not allowed here; only the
 * standard arm64 label is admitted so label changes require a deliberate gate
 * update.
 */
const ARM64_MACOS_RUNNER_LABELS = new Set(['macos-14']);

function checkCIPlatform(workflowPath) {
  const out = [];
  if (!fs.existsSync(workflowPath)) return out;
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const steps = Array.isArray(job.steps)
      ? job.steps.map((step) => step.run ?? '').join('\n')
      : '';
    if (steps.includes('verify:ci')) {
      const runner = String(job['runs-on'] ?? '');
      if (!ARM64_MACOS_RUNNER_LABELS.has(runner)) {
        out.push(
          `CI job ${jobName} runs V4 verify:ci on ${runner || '(missing runs-on)'}; Active artifacts are aarch64-apple-darwin, so canonical V4 verification must run on the arm64 GitHub-hosted label ${[...ARM64_MACOS_RUNNER_LABELS].join(', ')} (macos-14 is ARM64 per the 2025-09-19 hosted-runner label change; Intel labels such as macos-14-large/macos-15-intel are rejected)`,
        );
      }
    }
  }
  return out;
}

function checkCIRunnerArch(ci, arch) {
  if (!ci) return [];
  return arch === 'arm64'
    ? []
    : [`CI node process arch=${arch}; Active artifacts are aarch64-apple-darwin, so V4 verify:ci must run on an arm64 runner`];
}

function checkDeclaredExecutedBinding(verificationMapPath, architectureDir) {
  const out = [];
  const declaredGates = new Set();
  const declaredConsumers = new Set();
  const declaredConsumerDetails = new Map();
  const map = JSON.parse(fs.readFileSync(verificationMapPath, 'utf8'));
  for (const gate of map.gates ?? []) {
    const command = String(gate.command ?? '');
    for (const match of command.matchAll(/node scripts\/architecture\/(verify-v4-[a-z0-9-]+\.mjs)/g)) {
      declaredGates.add(match[1]);
    }
    for (const match of command.matchAll(/test-consumer[^\n]*--consumer\s+([a-z0-9-]+)/g)) {
      declaredConsumers.add(match[1]);
    }
    const consumer = command.match(/test-consumer[^\n]*--consumer\s+([a-z0-9-]+)/)?.[1];
    if (!consumer) continue;
    const deps = command.match(/--deps\s+([^\s]+)/)?.[1] ?? '';
    const sourceDeps = command.match(/--source-deps\s+([^\s]+)/)?.[1] ?? '';
    declaredConsumerDetails.set(consumer, { deps, sourceDeps });
  }
  const executedGates = new Set(ARCHITECTURE_GATES);
  for (const [gate] of RED_SUITES) executedGates.add(gate);
  const executedConsumers = new Set(CONSUMER_REGRESSIONS.map(([consumer]) => consumer));
  const executedConsumerDetails = new Map();
  for (const [consumer, deps, ...extra] of CONSUMER_REGRESSIONS) {
    const sourceIndex = extra.indexOf('--source-deps');
    executedConsumerDetails.set(consumer, {
      deps,
      sourceDeps: sourceIndex >= 0 ? (extra[sourceIndex + 1] ?? '') : '',
    });
  }

  const unregistered = [...executedGates].filter((gate) => !declaredGates.has(gate));
  if (unregistered.length > 0) {
    out.push(`architecture gates executed but not registered in verification-map.json: ${unregistered.join(', ')}`);
  }
  const neverExecuted = [...declaredGates].filter((gate) => !executedGates.has(gate));
  if (neverExecuted.length > 0) {
    out.push(`architecture gates registered in verification-map.json but not executed: ${neverExecuted.join(', ')}`);
  }
  for (const gate of declaredGates) {
    if (!fs.existsSync(path.join(architectureDir, gate))) {
      out.push(`architecture gate file missing: ${gate}`);
    }
  }
  if (fs.existsSync(architectureDir)) {
    for (const file of fs.readdirSync(architectureDir)) {
      if (/^verify-v4-[a-z0-9-]+\.mjs$/.test(file) && !executedGates.has(file)) {
        out.push(`architecture gate file never executed: ${file}`);
      }
    }
  }
  const declaredList = [...declaredConsumers].sort();
  const executedList = [...executedConsumers].sort();
  if (JSON.stringify(declaredList) !== JSON.stringify(executedList)) {
    out.push(`declared consumers ${JSON.stringify(declaredList)} != executed consumers ${JSON.stringify(executedList)}`);
  }
  for (const [consumer, executed] of executedConsumerDetails) {
    const declared = declaredConsumerDetails.get(consumer);
    if (!declared) continue;
    if (declared.deps !== executed.deps || declared.sourceDeps !== executed.sourceDeps) {
      out.push(`consumer ${consumer} declared test-consumer args ${JSON.stringify(declared)} != executed ${JSON.stringify(executed)}`);
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
  path.join(v4Root, 'package.json'),
);
if (dispatcherFailures.length > 0) {
  failures.push(`root dispatchers:\n${dispatcherFailures.join('\n')}`);
}
const ciPlatformFailures = checkCIPlatform(
  path.join(v4Root, '../.github/workflows/test.yml'),
);
if (ciPlatformFailures.length > 0) {
  failures.push(`CI platform:\n${ciPlatformFailures.join('\n')}`);
}
const ciArchFailures = checkCIRunnerArch(process.env.CI, process.arch);
if (ciArchFailures.length > 0) {
  failures.push(`CI runner arch:\n${ciArchFailures.join('\n')}`);
}
const bindingFailures = checkDeclaredExecutedBinding(
  path.join(v4Root, '.appsdk/maps/verification-map.json'),
  path.join(v4Root, 'scripts/architecture'),
);
if (bindingFailures.length > 0) {
  failures.push(`declared vs executed gate binding:\n${bindingFailures.join('\n')}`);
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
  [
    "import { run } from './_common.mjs';",
    "run('cargo run --release -p routecodex-v4-build-link -- build-consumer --out ../../escape.rlib');",
    "run('cargo run --release -p routecodex-v4-build-link -- build-consumer --out=../../escape.rlib');",
    "run('cargo run --release -p routecodex-v4-build-link -- build-consumer --out \"../escape.rlib\"');",
    "run('cp build-control/src.rlib ../escape.rlib');",
    "run('cp build-control/src.rlib /tmp/escape.rlib');",
  ].join('\n'),
);
const outputProblems = scanOutputTargets(
  walkFiles(outputDir, 'scripts/isolation-red/output-escape'),
  redDir,
);
expectReject('output target escaping v4', () => outputProblems);

// R8: root npm dispatcher must be a thin npm --prefix v4 wrapper.
const rootPkgFixture = path.join(redDir, 'package.json');
fs.writeFileSync(
  rootPkgFixture,
  '{"scripts":{"build:v4":"node scripts/build.mjs","verify:v4":"npm --prefix v4 run verify:ci"}}\n',
);
const rootPkgProblems = checkRootDispatchers(rootPkgFixture, path.join(redDir, 'test.yml'));
expectReject('root npm dispatcher not thin', () => rootPkgProblems);

// R9: V4 verify:ci must run on a macOS runner (Active artifacts are darwin).
const ciPlatformDir = path.join(redDir, 'ci-platform');
fs.mkdirSync(ciPlatformDir, { recursive: true });
fs.writeFileSync(
  path.join(ciPlatformDir, 'test.yml'),
  'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm --prefix v4 run verify:ci\n',
);
const ciPlatformProblems = checkCIPlatform(path.join(ciPlatformDir, 'test.yml'));
expectReject('V4 verify:ci on non-macOS runner', () => ciPlatformProblems);

// R10: verification-map declared gates must match the executed matrix.
const bindingDir = path.join(redDir, 'binding');
fs.mkdirSync(path.join(bindingDir, 'architecture'), { recursive: true });
fs.writeFileSync(
  path.join(bindingDir, 'verification-map.json'),
  JSON.stringify({
    gates: [
      { gate_id: 'g1', command: 'node scripts/architecture/verify-v4-declared-only.mjs' },
      { gate_id: 'g2', command: 'node scripts/architecture/verify-v4-executed.mjs' },
      { gate_id: 'g3', command: 'cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- test-consumer --root . --consumer routecodex-v4-runtime --deps routecodex-v4-error,routecodex-v4-base-node,routecodex-v4-control' },
    ],
  }),
);
fs.writeFileSync(path.join(bindingDir, 'architecture/verify-v4-executed.mjs'), '');
const bindingProblems = checkDeclaredExecutedBinding(
  path.join(bindingDir, 'verification-map.json'),
  path.join(bindingDir, 'architecture'),
);
expectReject('declared vs executed gate binding drift', () => bindingProblems);

// R11: V4 verify:ci must run on an arm64 macOS runner, not an Intel macOS
// runner (macos-14-large is the current GitHub-hosted x86_64 label).
const ciPlatformX86Dir = path.join(redDir, 'ci-platform-x86');
fs.mkdirSync(ciPlatformX86Dir, { recursive: true });
fs.writeFileSync(
  path.join(ciPlatformX86Dir, 'test.yml'),
  'jobs:\n  test:\n    runs-on: macos-14-large\n    steps:\n      - run: npm --prefix v4 run verify:ci\n',
);
const ciPlatformX86Problems = checkCIPlatform(path.join(ciPlatformX86Dir, 'test.yml'));
expectReject('V4 verify:ci on Intel macOS runner (macos-14-large)', () => ciPlatformX86Problems);

// R12: on CI, the actual runner process must be arm64.
const ciArchX64Problems = checkCIRunnerArch('true', 'x64');
expectReject('V4 verify:ci on an x64 CI process', () => ciArchX64Problems);

// R13: root dispatchers named after a V4 script must bind to that exact
// v4/package.json script (no name-semantic drift).
const rootPkgDriftDir = path.join(redDir, 'root-dispatcher-drift');
fs.mkdirSync(rootPkgDriftDir, { recursive: true });
fs.writeFileSync(
  path.join(rootPkgDriftDir, 'package.json'),
  '{"scripts":{"verify:v4-active-link":"npm --prefix v4 run verify:v4-active-link","verify:v4-foundation":"npm --prefix v4 run verify"}}\n',
);
fs.writeFileSync(
  path.join(rootPkgDriftDir, 'v4-package.json'),
  '{"scripts":{"verify:v4-active-link":"node scripts/architecture/verify-v4-active-link.mjs"}}\n',
);
const rootPkgDriftProblems = checkRootDispatchers(
  path.join(rootPkgDriftDir, 'package.json'),
  path.join(rootPkgDriftDir, 'test.yml'),
  path.join(rootPkgDriftDir, 'v4-package.json'),
);
expectReject('root dispatcher name-semantic drift', () => rootPkgDriftProblems);

if (redFail > 0) {
  console.error(`[v4 isolation] red fixtures failed: ${redFail}`);
  process.exit(1);
}
console.log('[v4 isolation] OK red fixtures rejected');
