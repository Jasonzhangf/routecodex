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
  const forbiddenRootNames = new Set(['.reasonix', 'note.md.d', 'vendor']);
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
      'scripts/architecture/verify-repository-filesystem-governance.mjs',
      'scripts/tests/repository-filesystem-governance-red-fixtures.mjs',
      'scripts/start-verify.mjs',
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

  const tracked = lines(git(['ls-files']));
  for (const trackedPath of tracked) {
    if (trackedPath.startsWith('dist/')) failures.push(`tracked generated output: ${trackedPath}`);
    if (trackedPath.startsWith('.reasonix/')) failures.push(`tracked deprecated tool state: ${trackedPath}`);
    if (trackedPath.startsWith('samples/mock-provider/_archive/')) failures.push(`tracked deprecated sample archive: ${trackedPath}`);
    if (trackedPath.startsWith('docs/architecture/backups/')) failures.push(`tracked architecture backup: ${trackedPath}`);
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
