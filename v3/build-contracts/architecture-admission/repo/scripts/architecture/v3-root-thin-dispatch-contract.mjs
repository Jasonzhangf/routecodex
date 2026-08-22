import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function collectV3RootThinDispatchFailures({
  rootPackageText,
  changedPaths = [],
} = {}) {
  const failures = [];
  let rootPackage;
  try {
    rootPackage = JSON.parse(rootPackageText);
  } catch (error) {
    return [`root package.json is invalid: ${error.message}`];
  }

  if (rootPackage.bin !== undefined) {
    failures.push('root package must not publish the retired root dist binary');
  }
  if (Array.isArray(rootPackage.files) && rootPackage.files.includes('dist/')) {
    failures.push('root package must not ship retired root dist output');
  }
  for (const scriptName of ['start', 'dev', 'start:bg', 'start:fg']) {
    if (rootPackage.scripts?.[scriptName] !== undefined) {
      failures.push(`root package lifecycle alias must remain retired: ${scriptName}`);
    }
  }
  if (changedPaths.includes('src/build-info.ts')) {
    failures.push('V3 independent build isolation must not modify root runtime build-info');
  }
  return failures;
}

export function detectV3IsolationChangedPaths({ repoRoot, env = process.env } = {}) {
  const explicitPaths = String(env.V3_ISOLATION_CHANGED_PATHS ?? '').trim();
  if (explicitPaths) {
    return explicitPaths.split('\n').map((path) => path.trim()).filter(Boolean);
  }

  const explicitBase = String(env.V3_ISOLATION_BASE_COMMIT ?? '').trim();
  const candidates = explicitBase && !/^0+$/u.test(explicitBase)
    ? [explicitBase]
    : ['refs/remotes/origin/main', 'refs/heads/main'];
  for (const candidate of candidates) {
    const mergeBase = spawnSync('git', ['merge-base', 'HEAD', candidate], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (mergeBase.status !== 0) {
      if (explicitBase) throw new Error(`cannot resolve V3 isolation base commit: ${candidate}`);
      continue;
    }
    const diff = spawnSync('git', ['diff', '--name-only', mergeBase.stdout.trim(), '--'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (diff.status === 0) {
      return diff.stdout.split('\n').map((path) => path.trim()).filter(Boolean);
    }
  }
  return [];
}

export function assertV3RootThinDispatchRedFixtures() {
  const valid = JSON.stringify({
    files: ['README.md'],
    scripts: { verify: 'npm --prefix v3 run verify:ci' },
  });
  assert.deepEqual(collectV3RootThinDispatchFailures({ rootPackageText: valid }), []);
  for (const mutation of [
    { bin: { rccv3: 'dist/bin/rccv3' } },
    { files: ['dist/'] },
    { scripts: { start: 'dist/bin/rccv3 server start' } },
    { scripts: { dev: 'dist/bin/rccv3 server start --foreground' } },
    { scripts: { 'start:bg': 'dist/bin/rccv3 server start' } },
    { scripts: { 'start:fg': 'dist/bin/rccv3 server start --foreground' } },
  ]) {
    assert(collectV3RootThinDispatchFailures({
      rootPackageText: JSON.stringify(mutation),
    }).length > 0);
  }
  assert(collectV3RootThinDispatchFailures({
    rootPackageText: valid,
    changedPaths: ['src/build-info.ts'],
  }).some((failure) => failure.includes('root runtime build-info')));
}

export function verifyV3RootThinDispatch({ repoRoot, env = process.env } = {}) {
  assertV3RootThinDispatchRedFixtures();
  const packagePath = resolve(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return [];
  return collectV3RootThinDispatchFailures({
    rootPackageText: readFileSync(packagePath, 'utf8'),
    changedPaths: detectV3IsolationChangedPaths({ repoRoot, env }),
  });
}
