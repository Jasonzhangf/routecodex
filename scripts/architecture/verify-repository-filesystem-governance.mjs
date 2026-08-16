import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const rootArg = process.argv.indexOf('--root');
const repoRoot = path.resolve(rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd());

function git(args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || '');
}

function lines(value) {
  return value.split('\n').map((entry) => entry.trim()).filter(Boolean);
}

function verifyRepositoryFilesystemGovernance() {
  const failures = [];
  const rootEntries = fs.readdirSync(repoRoot);
  const forbiddenRootNames = new Set(['--version', 'note.md.d', 'vendor']);
  const forbiddenActiveV2Directories = [
    'docs/v2-architecture',
    'scripts/v2-consistency',
    'src/v2',
    'tests/v2',
  ];
  const activeMachineMaps = [
    'docs/architecture/resource-operation-map.yml',
    'docs/architecture/function-map.yml',
    'docs/architecture/mainline-call-map.yml',
    'docs/architecture/verification-map.yml',
    'docs/architecture/no-fallback-diff-rules.json',
  ];
  let moduleOwner;
  const moduleRegistryPath = path.join(
    repoRoot,
    'docs/architecture/repository-filesystem-module-registry.yml',
  );

  if (!fs.existsSync(moduleRegistryPath)) {
    failures.push('repository filesystem module registry is missing');
  } else {
    const registry = YAML.parse(fs.readFileSync(moduleRegistryPath, 'utf8'));
    moduleOwner = registry?.modules?.find(
      (module) => module?.module_id === 'architecture.repository_filesystem_governance',
    );
    const requiredOwnedPaths = [
      '.gitignore',
      'scripts/ci/repo-sanity.mjs',
      'scripts/ci/mempalace-scan-artifact-audit.mjs',
      'scripts/architecture/verify-repository-filesystem-governance.mjs',
      'scripts/tests/repository-filesystem-governance-red-fixtures.mjs',
      'v3/README.md',
      'v3/fixtures',
      'deprecated/v2',
      'docs/audits/repository-root-layout-v3-v2-audit.md',
      'docs/goals/repository-root-retirement-v4-v3-integration-plan.md',
    ];
    if (registry?.status !== 'active') failures.push('repository filesystem module registry must be active');
    if (!moduleOwner) failures.push('repository filesystem module owner is missing');
    for (const ownedPath of requiredOwnedPaths) {
      if (!moduleOwner?.owned_paths?.includes(ownedPath)) failures.push(`module registry missing owned path: ${ownedPath}`);
    }
    const hasVerifyEdge = moduleOwner?.allowed_edges?.some(
      (edge) => edge?.from === 'RepoFilesystemAuthoring01Policy'
        && edge?.to === 'RepoFilesystemVerify02Gate',
    );
    if (!hasVerifyEdge) failures.push('module registry missing authoring-to-verifier edge');
  }

  for (const name of rootEntries) {
    if (forbiddenRootNames.has(name)) failures.push(`forbidden root entry: ${name}`);
    if (name.startsWith('fwd.')) failures.push(`forbidden root marker: ${name}`);
    if (name.startsWith('install:')) failures.push(`forbidden malformed install root: ${JSON.stringify(name)}`);
  }

  for (const relativePath of forbiddenActiveV2Directories) {
    if (fs.existsSync(path.join(repoRoot, relativePath))) {
      failures.push(`active V2 directory must be archived: ${relativePath}`);
    }
  }

  for (const relativePath of activeMachineMaps) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    if (fs.readFileSync(absolutePath, 'utf8').includes('deprecated/v2/')) {
      failures.push(`active machine map must not bind retired V2 archive: ${relativePath}`);
    }
  }

  const deprecatedRoot = path.join(repoRoot, 'deprecated');
  if (fs.existsSync(deprecatedRoot)) {
    for (const entry of fs.readdirSync(deprecatedRoot)) {
      if (entry !== 'v2') failures.push(`unsupported deprecated root child: deprecated/${entry}`);
    }
    if (!fs.existsSync(path.join(deprecatedRoot, 'v2/README.md'))) {
      failures.push('deprecated V2 archive must have deprecated/v2/README.md');
    }
  }

  const pendingDeletions = new Set(lines(git(['diff', '--name-only', '--diff-filter=D'])));
  for (const path of lines(git(['diff', '--cached', '--name-only', '--diff-filter=D']))) {
    pendingDeletions.add(path);
  }
  const tracked = lines(git(['ls-files'])).filter((trackedPath) => !pendingDeletions.has(trackedPath));
  const requiredTrackedPaths = [
    'v3/fixtures/config.p2.toml',
  ];
  for (const requiredPath of requiredTrackedPaths) {
    if (!tracked.includes(requiredPath)) failures.push(`required governed source is not tracked: ${requiredPath}`);
  }
  for (const trackedPath of tracked) {
    if (trackedPath.startsWith('dist/')) failures.push(`tracked generated output: ${trackedPath}`);
    if (trackedPath.startsWith('.reasonix/')) failures.push(`tracked deprecated tool state: ${trackedPath}`);
    if (trackedPath === 'samples' || trackedPath.startsWith('samples/')) failures.push(`retired V2 sample surface must not be tracked: ${trackedPath}`);
    if (trackedPath.startsWith('docs/architecture/backups/')) failures.push(`tracked architecture backup: ${trackedPath}`);
    if (forbiddenActiveV2Directories.some((relativePath) => trackedPath === relativePath || trackedPath.startsWith(`${relativePath}/`))) {
      failures.push(`tracked active V2 path must be archived: ${trackedPath}`);
    }
  }

  const governedTrackedPaths = tracked.filter((trackedPath) =>
    moduleOwner?.owned_paths?.some(
      (ownedPath) => trackedPath === ownedPath || trackedPath.startsWith(`${ownedPath}/`),
    ));
  for (const governedPath of governedTrackedPaths) {
    const result = spawnSync('git', ['-C', repoRoot, 'check-ignore', '--no-index', '-q', governedPath]);
    if (result.status === 0) failures.push(`governed source path is ignored: ${governedPath}`);
  }

  if (failures.length > 0) {
    console.error('[verify:repository-filesystem-governance] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('[verify:repository-filesystem-governance] ok');
}

verifyRepositoryFilesystemGovernance();
