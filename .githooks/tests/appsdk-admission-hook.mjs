#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = mkdtempSync(join(tmpdir(), 'routecodex-appsdk-hook-'));
const repo = join(tempRoot, 'repo');
const output = (result) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    ...options,
  });
}
function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}
function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}\n${output(result)}`);
  return result;
}
function expectFailure(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label}\n${output(result)}`);
  assert.match(output(result), pattern);
  return result;
}
function writeTextAt(root, relativePath, contents, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) chmodSync(path, mode);
}

function writeText(relativePath, contents, mode) {
  writeTextAt(repo, relativePath, contents, mode);
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProjectRoots() {
  for (const prefix of ['', 'v3/', 'v4/']) {
    const modules =
      prefix === 'v4/'
        ? ['routecodex-v4-base-node', 'routecodex-v4-edge', 'routecodex-v4-control']
            .map((module_id) => ({ module_id, stage: 'frozen' }))
        : [];
    writeJson(`${prefix}.appsdk/project.json`, {
      sdk: { name: 'appsdk', version: '0.1.0014' },
      modules,
    });
    writeJson(`${prefix}.appsdk/sdk.lock`, { version: '0.1.0014' });
    writeJson(`${prefix}.appsdk/contracts/sdk-bundle.manifest.json`, {
      version: '0.1.0014',
    });
    writeJson(`${prefix}.appsdk/sdk-resources.json`, { version: '0.1.0014' });
  }
}

function copyPath(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function runHook(hook, env, input = '', cwd = repo) {
  return run('sh', [join('.githooks', hook)], {
    cwd,
    env: { ...process.env, ...env },
    input,
  });
}

function runRealAppsdkHookRegression() {
  const realRoot = process.env.ROUTECODEX_REAL_APPSDK_ROOT ?? sourceRoot;
  const realAppsdk = process.env.ROUTECODEX_REAL_APPSDK_BIN ?? 'appsdk';
  const realEnv = { ...process.env };
  delete realEnv.APPSDK_BIN;

  const version = spawnSync(realAppsdk, ['version'], {
    encoding: 'utf8',
    env: realEnv,
  });
  if (version.error || version.status !== 0) {
    throw new Error(
      `real AppSDK version probe failed: ${version.error?.message ?? version.status}\n${version.stderr}`,
    );
  }
  assert.equal(version.stdout.trim(), 'appsdk 0.1.0014 (rust)');
  const project = JSON.parse(
    readFileSync(join(realRoot, 'v4/.appsdk/project.json'), 'utf8'),
  );
  const frozenModules = (project.modules ?? []).filter(
    (module) => module.stage === 'frozen',
  );
  if (project.sdk?.version !== '0.1.0014' || frozenModules.length === 0) {
    if (
      process.env.ROUTECODEX_REAL_APPSDK_ROOT ||
      process.env.ROUTECODEX_REQUIRE_REAL_APPSDK_FIXTURE === '1'
    ) {
      throw new Error(
        `${realRoot} is not a canonical 0.1.0014 root with frozen v4 modules`,
      );
    }
    console.log(
      '[test:appsdk-admission-hook] SKIP real AppSDK hook regression: sourceRoot is pre-upgrade; set ROUTECODEX_REAL_APPSDK_ROOT to a combined tree',
    );
    return;
  }
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'routecodex-appsdk-hook-real-'));
  const fixtureRepo = join(fixtureRoot, 'repo');
  const fixture = join(fixtureRoot, 'linked');
  try {
    mustRun(
      'git',
      ['clone', '--shared', '--no-checkout', '--quiet', realRoot, fixtureRepo],
      { cwd: tempRoot },
    );
    mustRun(
      'git',
      ['worktree', 'add', '--detach', '--quiet', fixture, 'HEAD'],
      { cwd: fixtureRepo },
    );
    const governancePaths = [
      '.appsdk', 'contracts', 'v3/.appsdk', 'v3/contracts',
      'v4/.appsdk', 'v4/contracts', 'v4/protected',
    ];
    for (const relativePath of governancePaths) {
      copyPath(join(realRoot, relativePath), join(fixture, relativePath));
    }
    for (const relativePath of [
      '.githooks/pre-commit',
      '.githooks/pre-push',
      '.githooks/verify-appsdk-admission.mjs',
    ]) {
      copyPath(join(sourceRoot, relativePath), join(fixture, relativePath));
    }
    writeTextAt(
      fixture,
      'package.json',
      `${JSON.stringify({ scripts: { 'verify:fast': 'node scripts/verify-fast.mjs' } }, null, 2)}\n`,
    );
    writeTextAt(fixture, 'scripts/verify-fast.mjs', 'process.exit(0);\n');
    for (const module of frozenModules) {
      const merge = JSON.parse(
        readFileSync(
          join(
            fixture,
            `v4/.appsdk/records/merge-record-${module.module_id}.json`,
          ),
          'utf8',
        ),
      );
      mustRun('git', ['update-ref', merge.mainline_ref, merge.merge_commit], {
        cwd: fixture,
      });
    }
    mustRun('git', ['add', '-A'], { cwd: fixture }); mustRun('git', ['add', '-f', 'v4/.appsdk/contracts/memory'], { cwd: fixture });
    const env = { ...realEnv, APPSDK_BIN: realAppsdk };
    const preCommit = runHook('pre-commit', env, '', fixture);
    expectStatus(preCommit, 0, 'positive real pre-commit hook');
    assert.match(output(preCommit), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);
    const head = mustRun('git', ['rev-parse', 'HEAD'], {
      cwd: fixture,
    }).stdout.trim();
    const commitEnv = {
      ...realEnv,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const commitCandidate = (tree, message) =>
      mustRun('git', ['commit-tree', tree, '-p', head, '-m', message], {
        cwd: fixture,
        env: commitEnv,
      }).stdout.trim();
    const good = commitCandidate(
      mustRun('git', ['write-tree'], { cwd: fixture }).stdout.trim(),
      'hook candidate',
    );
    const prePush = runHook(
      'pre-push',
      env,
      `refs/heads/test ${good} refs/heads/test ${head}\n`,
      fixture,
    );
    expectStatus(prePush, 0, 'positive real pre-push hook');
    assert.match(output(prePush), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);
    const victim = frozenModules[0].module_id;
    const reviewPath = `v4/.appsdk/records/review-record-${victim}.json`;
    const review = JSON.parse(readFileSync(join(fixture, reviewPath), 'utf8'));
    review.verdict = 'fail';
    writeTextAt(fixture, reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    mustRun('git', ['add', reviewPath], { cwd: fixture });
    const badPreCommit = runHook('pre-commit', env, '', fixture);
    expectFailure(
      badPreCommit,
      new RegExp(`v4: review-admission ${victim} exited 1`),
      'damaged real pre-commit hook',
    );
    const bad = commitCandidate(
      mustRun('git', ['write-tree'], { cwd: fixture }).stdout.trim(),
      'damaged historical records',
    );
    const badPrePush = runHook(
      'pre-push',
      env,
      `refs/heads/test ${bad} refs/heads/test ${head}\n`,
      fixture,
    );
    expectFailure(
      badPrePush,
      new RegExp(`v4: review-admission ${victim} exited 1`),
      'damaged real pre-push hook',
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

try {
  mkdirSync(repo, { recursive: true });
  mustRun('git', ['init', '-q']);
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/test']);

  writeText('README.md', '# hook fixture\n');
  writeJson('package.json', {
    scripts: { 'verify:fast': 'node scripts/verify-fast.mjs' },
  });
  writeText('scripts/verify-fast.mjs', 'process.exit(0);\n');
  writeProjectRoots();

  for (const relativePath of [
    '.githooks/pre-commit',
    '.githooks/pre-push',
    '.githooks/verify-appsdk-admission.mjs',
  ]) {
    const destination = join(repo, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceRoot, relativePath), destination);
  }

  const fakeAppsdk = join(repo, 'bin/appsdk');
  writeText(
    'bin/appsdk',
    [
      '#!/bin/sh',
      'set -eu',
      'case "${1:-}" in',
      '  version)',
      "    printf 'appsdk 0.1.0014 (rust)\\n'",
      '    ;;',
      '  verify)',
      '    if [ "${2:-}" = "--review-admission" ]; then',
      '      module_id="${5:-}"',
      '      if [ "${3:-}" != "v4" ] || [ "${4:-}" != "--module" ] || [ -z "$module_id" ]; then',
      "        printf 'unsupported fake appsdk review-admission arguments\\n' >&2",
      '        exit 2',
      '      fi',
      '      if [ -n "${FAKE_APPSDK_REVIEW_FAIL_MODULE:-}" ] && [ "$module_id" = "$FAKE_APPSDK_REVIEW_FAIL_MODULE" ]; then',
      '        printf "FAKE_REVIEW_ADMISSION_FAILURE:%s\\n" "$module_id" >&2',
      '        exit "${FAKE_APPSDK_REVIEW_FAIL_STATUS:-1}"',
      '      fi',
      '      printf \'{"ok":true,"gate":"review_admission","module_id":"%s","mode":"historical"}\\n\' "$module_id"',
      '      exit 0',
      '    fi',
      '    target="${2:-.}"',
      '    if [ -n "${FAKE_APPSDK_FAIL_TARGET:-}" ] && [ "$target" = "$FAKE_APPSDK_FAIL_TARGET" ]; then',
      '      if [ -n "${FAKE_APPSDK_FAIL_OUTPUT:-}" ]; then',
      '        printf "%b\\n" "$FAKE_APPSDK_FAIL_OUTPUT" >&2',
      '      else',
      '        printf "FAKE_VERIFY_FAILURE:%s\\n" "$target" >&2',
      '      fi',
      '      exit "${FAKE_APPSDK_FAIL_STATUS:-1}"',
      '    fi',
      '    if [ "$target" = "v4" ] && [ "${FAKE_APPSDK_V4_JSON_OK:-}" != "1" ]; then',
      "      printf 'ACTIVE_ARTIFACT_MISSING\\n'",
      '      exit 1',
      '    fi',
      "    printf '{\"baseline_status\":\"current\",\"command_ok\":true,\"delivery_assessed\":false,\"delivery_verified\":false,\"development_ready\":true,\"ok\":false,\"reason\":\"delivery_not_evaluated\"}\\n'",
      '    ;;',
      '  *)',
      "    printf 'unsupported fake appsdk arguments\\n' >&2",
      '    exit 2',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    0o755,
  );

  mustRun('git', ['add', '.']);
  mustRun('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial']);
  const initialSha = mustRun('git', ['rev-parse', 'HEAD']).stdout.trim();

  writeText('README.md', '# staged change\n');
  mustRun('git', ['add', 'README.md']);
  const positiveCommit = runHook('pre-commit', { APPSDK_BIN: fakeAppsdk });
  expectStatus(positiveCommit, 0, 'positive pre-commit');
  assert.match(output(positiveCommit), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);

  mustRun('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'good change']);
  const goodSha = mustRun('git', ['rev-parse', 'HEAD']).stdout.trim();
  const positivePush = runHook(
    'pre-push',
    { APPSDK_BIN: fakeAppsdk },
    `refs/heads/test ${goodSha} refs/heads/test ${initialSha}\n`,
  );
  expectStatus(positivePush, 0, 'positive pre-push');
  assert.match(output(positivePush), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);

  writeJson('.appsdk/project.json', {
    sdk: { name: 'appsdk', version: '0.1.7' },
  });
  mustRun('git', ['add', '.appsdk/project.json']);
  writeJson('.appsdk/project.json', {
    sdk: { name: 'appsdk', version: '0.1.0014' },
  });
  const negativeIndex = runHook('pre-commit', { APPSDK_BIN: fakeAppsdk });
  expectFailure(negativeIndex, /expected 0\.1\.0014/, 'negative staged index');

  mustRun('git', ['reset', '-q', 'HEAD', '--', '.appsdk/project.json']);
  writeJson('.appsdk/project.json', {
    sdk: { name: 'appsdk', version: '0.1.7' },
  });
  mustRun('git', ['add', '.appsdk/project.json']);
  mustRun('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'bad contract']);
  const badSha = mustRun('git', ['rev-parse', 'HEAD']).stdout.trim();
  writeJson('.appsdk/project.json', {
    sdk: { name: 'appsdk', version: '0.1.0014' },
  });

  const negativePush = runHook(
    'pre-push',
    { APPSDK_BIN: fakeAppsdk },
    `refs/heads/test ${badSha} refs/heads/test ${goodSha}\n`,
  );
  expectFailure(negativePush, /expected 0\.1\.0014/, 'negative pushed commit');

  const verifyFailure = run(
    process.execPath,
    ['.githooks/verify-appsdk-admission.mjs', repo],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        APPSDK_BIN: fakeAppsdk,
        FAKE_APPSDK_FAIL_TARGET: 'v3',
      },
    },
  );
  expectFailure(verifyFailure, /v3: appsdk verify exited 1/, 'v3 verify failure');

  const activeMissingAllowed = run(
    process.execPath,
    ['.githooks/verify-appsdk-admission.mjs', repo],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        APPSDK_BIN: fakeAppsdk,
        FAKE_APPSDK_V4_JSON_OK: '0',
      },
    },
  );
  expectStatus(activeMissingAllowed, 0, 'v4 delivery gap admission');
  assert.match(output(activeMissingAllowed), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);
  assert.match(output(activeMissingAllowed), /CONTRACT_PASS roots=\.\,v3,v4/);
  assert.doesNotMatch(output(activeMissingAllowed), /\] PASS roots=/);

  const reviewAdmissionFailure = run(
    process.execPath,
    ['.githooks/verify-appsdk-admission.mjs', repo],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        APPSDK_BIN: fakeAppsdk,
        FAKE_APPSDK_REVIEW_FAIL_MODULE: 'routecodex-v4-control',
      },
    },
  );
  expectFailure(
    reviewAdmissionFailure,
    /v4: review-admission routecodex-v4-control exited 1/,
    'review-admission failure',
  );
  assert.doesNotMatch(output(reviewAdmissionFailure), /DELIVERY_GAP v4: ACTIVE_ARTIFACT_MISSING/);

  const combinedV4Failure = run(
    process.execPath,
    ['.githooks/verify-appsdk-admission.mjs', repo],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        APPSDK_BIN: fakeAppsdk,
        FAKE_APPSDK_FAIL_TARGET: 'v4',
        FAKE_APPSDK_FAIL_OUTPUT: 'ACTIVE_ARTIFACT_MISSING\nOTHER_ERROR',
      },
    },
  );
  expectFailure(combinedV4Failure, /v4: appsdk verify exited 1/, 'combined v4 failure');

  const unexpectedV4Status = run(
    process.execPath,
    ['.githooks/verify-appsdk-admission.mjs', repo],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        APPSDK_BIN: fakeAppsdk,
        FAKE_APPSDK_FAIL_TARGET: 'v4',
        FAKE_APPSDK_FAIL_OUTPUT: 'ACTIVE_ARTIFACT_MISSING',
        FAKE_APPSDK_FAIL_STATUS: '2',
      },
    },
  );
  expectFailure(unexpectedV4Status, /v4: appsdk verify exited 2/, 'unexpected v4 status');

  writeText('.githooks/verify-appsdk-admission.mjs', '// verifier drift\n');
  const driftedIndex = runHook('pre-commit', { APPSDK_BIN: fakeAppsdk });
  expectFailure(
    driftedIndex,
    /working-tree verifier drifted from staged file/,
    'staged verifier drift',
  );
  copyFileSync(
    join(sourceRoot, '.githooks/verify-appsdk-admission.mjs'),
    join(repo, '.githooks/verify-appsdk-admission.mjs'),
  );

  writeText('.githooks/verify-appsdk-admission.mjs', '// verifier drift\n');
  const driftedPush = runHook(
    'pre-push',
    { APPSDK_BIN: fakeAppsdk },
    `refs/heads/test ${goodSha} refs/heads/test ${initialSha}\n`,
  );
  expectFailure(
    driftedPush,
    /working-tree verifier drifted from pushed file/,
    'pushed verifier drift',
  );
  copyFileSync(
    join(sourceRoot, '.githooks/verify-appsdk-admission.mjs'),
    join(repo, '.githooks/verify-appsdk-admission.mjs'),
  );

  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const protectedCommit = runHook('pre-commit', { APPSDK_BIN: fakeAppsdk });
  expectFailure(protectedCommit, /commits on main are disabled/, 'main commit protection');
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/test']);

  const protectedPush = runHook(
    'pre-push',
    { APPSDK_BIN: fakeAppsdk },
    `refs/heads/main ${goodSha} refs/heads/main ${initialSha}\n`,
  );
  expectFailure(protectedPush, /updates to refs\/heads\/main are disabled/, 'main push protection');

  const protectedMasterPush = runHook(
    'pre-push',
    { APPSDK_BIN: fakeAppsdk },
    `refs/heads/master ${goodSha} refs/heads/master ${initialSha}\n`,
  );
  expectFailure(
    protectedMasterPush,
    /updates to refs\/heads\/master are disabled/,
    'master push protection',
  );

  runRealAppsdkHookRegression();
  console.log('[test:appsdk-admission-hook] PASS');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
