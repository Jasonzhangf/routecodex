#!/usr/bin/env node
/**
 * V4 source-scope verification: one shared data/control boundary check plus
 * the owner regressions for changed V4 modules. Full admission remains the
 * explicit path for architecture, build, contract, and release changes.
 */
import { execFileSync } from 'node:child_process';
import { MODULE_REGRESSIONS } from './_gate-matrix.mjs';
import { runIndependent, reportIndependentFailures, v4Root } from './_common.mjs';

const base = process.env.ROUTECODEX_GATE_DIFF_BASE;
const head = process.env.ROUTECODEX_GATE_DIFF_HEAD;
const zeroSha = /^0{40}$/u;

function changedFiles() {
  if (!head || !base) {
    throw new Error('ROUTECODEX_GATE_DIFF_BASE and ROUTECODEX_GATE_DIFF_HEAD are required');
  }
  const args = zeroSha.test(base)
    ? ['diff-tree', '--root', '--name-only', '-r', head]
    : ['diff', '--name-only', base, head];
  return [...new Set(execFileSync('git', args, { cwd: v4Root, encoding: 'utf8' })
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => path.startsWith('v4/') ? path.slice(3) : path))];
}

function moduleForPath(path) {
  const crate = /^crates\/([^/]+)\//u.exec(path);
  if (crate) return crate[1];
  const cordis = /^cordis\/([^/]+)\//u.exec(path);
  if (cordis) return cordis[1];
  return null;
}

function ownerCommands(modules) {
  const commands = [];
  for (const module of modules) {
    const moduleEntries = MODULE_REGRESSIONS.filter(({ label }) => label === `module:${module}`);
    for (const entry of moduleEntries) commands.push(entry);
    if (module === 'routecodex-v4-cordis-host') {
      commands.push({ label: `module:${module}`, command: 'npm run test:cordis-host' });
    } else if (moduleEntries.length === 0) {
      commands.push({
        label: `module:${module}`,
        command: `cargo test -p ${module} --manifest-path Cargo.toml --locked`,
      });
    }
  }
  return commands;
}

function metadataCommands(paths) {
  const commands = [];
  if (paths.includes('docs/architecture/maps/verification-map.json')) {
    commands.push({
      label: 'contract:verification-map',
      command: 'node scripts/architecture/verify-v4-feature-layer-batches.mjs',
    });
    commands.push({
      label: 'contract:verification-map-binding',
      command: 'node scripts/verify-isolation.mjs --verification-map-binding',
    });
  }
  return commands;
}

let paths;
try {
  paths = changedFiles();
} catch (error) {
  console.error(`[v4 verify:scoped] FAIL ${error.message}`);
  process.exit(1);
}

const modules = [...new Set(paths.map(moduleForPath).filter(Boolean))].sort();
const metadataChecks = metadataCommands(paths);
if (modules.length === 0) {
  const checks = [
    { label: 'shared:data-control-plane', command: 'node scripts/architecture/verify-v4-plane-isolation.mjs' },
    ...metadataChecks,
  ];
  console.log(`[v4 verify:scoped] metadata-only paths=${paths.join(',')} checks=${checks.length} labels=${checks.map(({ label }) => label).join(',')}`);
  if (process.env.RCCV4_SCOPED_PLAN_ONLY === '1') process.exit(0);
  const failures = runIndependent(checks);
  if (failures.length > 0) {
    reportIndependentFailures('verify:scoped', failures);
    process.exit(1);
  }
  console.log('[v4 verify:scoped] OK metadata-only');
  process.exit(0);
}

const checks = [
  { label: 'shared:data-control-plane', command: 'node scripts/architecture/verify-v4-plane-isolation.mjs' },
  ...ownerCommands(modules),
  ...metadataChecks,
];
console.log(`[v4 verify:scoped] modules=${modules.join(',')} checks=${checks.length} labels=${checks.map(({ label }) => label).join(',')}`);
if (process.env.RCCV4_SCOPED_PLAN_ONLY === '1') process.exit(0);

const failures = runIndependent(checks);
if (failures.length > 0) {
  reportIndependentFailures('verify:scoped', failures);
  process.exit(1);
}

console.log(`[v4 verify:scoped] OK modules=${modules.join(',')} shared-contract=ok`);
