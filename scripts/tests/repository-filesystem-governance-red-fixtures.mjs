import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const verifier = path.join(repoRoot, 'scripts/architecture/verify-repository-filesystem-governance.mjs');

const cases = [
  ['misparsed CLI option root', '--version/_/h', 'forbidden root entry'],
  ['root fwd marker', 'fwd.v3.invalid', 'forbidden root marker'],
  ['malformed install root', 'install:v3\n', 'forbidden malformed install root'],
  ['deprecated screenshot root', 'note.md.d/image.png', 'forbidden root entry'],
  ['deprecated vendor root', 'vendor/llmswitch-core/package.json', 'forbidden root entry'],
  ['tracked dist output', 'dist/debug/snapshot/writer.js', 'tracked generated output'],
  ['tracked reasonix state', '.reasonix/truncated-results/output.txt', 'forbidden root entry'],
  ['retired sample surface', 'samples/mock-provider/request.json', 'retired V2 sample surface must not be tracked'],
  ['active V2 architecture directory', 'docs/v2-architecture/README.md', 'active V2 directory must be archived'],
  ['active V2 consistency directory', 'scripts/v2-consistency/README.md', 'active V2 directory must be archived'],
  ['active V2 source directory', 'src/v2/README.md', 'active V2 directory must be archived'],
  ['active V2 test directory', 'tests/v2/README.md', 'active V2 directory must be archived'],
  ['unsupported deprecated root child', 'deprecated/v1/README.md', 'unsupported deprecated root child'],
  [
    'retired V2 active resource binding',
    'docs/architecture/resource-operation-map.yml',
    'active machine map must not bind retired V2 archive',
    'resources:\n  - owner: deprecated/v2/consistency/comprehensive-consistency-test.mjs\n',
  ],
  [
    'retired V2 active function binding',
    'docs/architecture/function-map.yml',
    'active machine map must not bind retired V2 archive',
    'features:\n  - owner_module: deprecated/v2/consistency/comprehensive-consistency-test.mjs\n',
  ],
  [
    'retired V2 active mainline binding',
    'docs/architecture/mainline-call-map.yml',
    'active machine map must not bind retired V2 archive',
    'functions:\n  - file: deprecated/v2/consistency/comprehensive-consistency-test.mjs\n',
  ],
  [
    'retired V2 active verification binding',
    'docs/architecture/verification-map.yml',
    'active machine map must not bind retired V2 archive',
    'verification:\n  - build: deprecated/v2/consistency/comprehensive-consistency-test.mjs\n',
  ],
  [
    'retired V2 active no-fallback rule',
    'docs/architecture/no-fallback-diff-rules.json',
    'active machine map must not bind retired V2 archive',
    '{"pathContains":"deprecated/v2/monitoring/v2-monitoring-analysis.mjs"}\n',
  ],
];

function run(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function installModuleRegistry(root) {
  const registryPath = 'docs/architecture/repository-filesystem-module-registry.yml';
  fs.mkdirSync(path.dirname(path.join(root, registryPath)), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, registryPath), path.join(root, registryPath));
  const fixturePath = 'v3/fixtures/config.p2.toml';
  fs.mkdirSync(path.dirname(path.join(root, fixturePath)), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, fixturePath), path.join(root, fixturePath));
  run(root, ['add', '-f', registryPath, fixturePath]);
}

const failures = [];
for (const [name, relativePath, expected, content = 'fixture\n'] of cases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-repo-governance-red-'));
  try {
    run(root, ['init', '-q']);
    installModuleRegistry(root);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    run(root, ['add', '-f', relativePath]);
    const result = spawnSync(process.execPath, [verifier, '--root', root], { encoding: 'utf8' });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!output.includes(expected)) failures.push(`${name}: missing expected failure ${expected}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ignoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-repo-governance-ignore-red-'));
try {
  run(ignoredRoot, ['init', '-q']);
  installModuleRegistry(ignoredRoot);
  const criticalPath = '.agents/skills/rcc-v3-architecture/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(ignoredRoot, criticalPath)), { recursive: true });
  fs.writeFileSync(path.join(ignoredRoot, criticalPath), 'fixture\n');
  fs.writeFileSync(path.join(ignoredRoot, '.gitignore'), '.agents/\n');
  run(ignoredRoot, ['add', '-f', criticalPath, '.gitignore']);
  const result = spawnSync(process.execPath, [verifier, '--root', ignoredRoot], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) failures.push('ignored critical source: verifier unexpectedly passed');
  else if (!output.includes('governed source path is ignored')) failures.push('ignored critical source: missing expected failure');
} finally {
  fs.rmSync(ignoredRoot, { recursive: true, force: true });
}

const ignoredReferenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-repo-governance-reference-red-'));
try {
  run(ignoredReferenceRoot, ['init', '-q']);
  installModuleRegistry(ignoredReferenceRoot);
  const referencePath = '.agents/skills/rcc-dev-skills/references/00-architecture-map.md';
  fs.mkdirSync(path.dirname(path.join(ignoredReferenceRoot, referencePath)), { recursive: true });
  fs.writeFileSync(path.join(ignoredReferenceRoot, referencePath), 'fixture\n');
  fs.writeFileSync(
    path.join(ignoredReferenceRoot, '.gitignore'),
    '.agents/skills/rcc-dev-skills/references/\n',
  );
  run(ignoredReferenceRoot, ['add', '-f', referencePath, '.gitignore']);
  const result = spawnSync(process.execPath, [verifier, '--root', ignoredReferenceRoot], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) failures.push('ignored governed reference: verifier unexpectedly passed');
  else if (!output.includes('governed source path is ignored')) failures.push('ignored governed reference: missing expected failure');
} finally {
  fs.rmSync(ignoredReferenceRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('[test:repository-filesystem-governance-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[test:repository-filesystem-governance-red-fixtures] ok');
console.log(`- red fixtures checked: ${cases.length + 2}`);
