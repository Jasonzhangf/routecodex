#!/usr/bin/env node

// Behavior regression for the real Git hooks in .githooks. Every case copies the
// real hooks plus the real verify:fast entrypoint into a throwaway Git fixture,
// then invokes the hook as a shell script, so exit status and diagnostics come
// from the code Git actually runs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = mkdtempSync(join(tmpdir(), 'routecodex-git-hooks-'));
const repo = join(tempRoot, 'repo');
const originRepo = join(tempRoot, 'origin.git');
const sentinelDir = join(tempRoot, 'sentinel-bin');
const isolatedBin = join(tempRoot, 'isolated-bin');
const sentinelLog = join(tempRoot, 'retired-commands.log');
const z40 = '0000000000000000000000000000000000000000';

function resolveTool(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve required tool on PATH: ${name}`);
}

const realGit = resolveTool('git');
const realSh = resolveTool('sh');
// Fixture-only Git environment: no inherited global/system config or hooks.
const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const fixturePath = `${sentinelDir}${delimiter}${process.env.PATH}`;

function readRetiredLog() {
  try {
    return readFileSync(sentinelLog, 'utf8').trim();
  } catch {
    return '';
  }
}

const output = (result) =>
  `${result.stdout ?? ''}\n${result.stderr ?? ''}${
    readRetiredLog() ? `\n[retired sentinels]\n${readRetiredLog()}` : ''
  }`;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    env: fixtureEnv,
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

function expectNoFastGate(result, label) {
  assert.doesNotMatch(output(result), /\[verify:fast\]/u, `${label}\n${output(result)}`);
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

function copyRealityIntoFixture() {
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const relativePath of ['.githooks/pre-commit', '.githooks/pre-push']) {
    const destination = join(repo, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceRoot, relativePath), destination);
    chmodSync(destination, 0o755);
  }
  for (const relativePath of ['scripts/verify-fast.mjs', 'scripts/gate-policy.mjs']) {
    copyFileSync(join(sourceRoot, relativePath), join(repo, relativePath));
  }
  // Read the installed repository dependencies; the fixture installs nothing.
  symlinkSync(join(sourceRoot, 'node_modules'), join(repo, 'node_modules'));
}

function resetRetiredLog() {
  rmSync(sentinelLog, { force: true });
}

function runHook(hook, env = {}, input = '', cwd = repo) {
  // Resolve the interpreter outside the overridden PATH, so the hook's own PATH
  // decides which git/npm it sees.
  return run(realSh, [join('.githooks', hook)], {
    cwd,
    env: {
      ...fixtureEnv,
      PATH: fixturePath,
      ROUTECODEX_REAL_GIT: realGit,
      ROUTECODEX_RETIRED_LOG: sentinelLog,
      ...env,
    },
    input,
  });
}

function assertNoRetiredMachinery(label, result) {
  const hit = readRetiredLog();
  assert.equal(hit, '', `${label} invoked retired machinery:\n${hit}\n${output(result)}`);
  const checked = /\[verify:fast\] PASS checked ([1-9]\d*) file version\(s\)/u.exec(output(result));
  assert.ok(checked, `${label} did not run the real verify:fast file checks\n${output(result)}`);
}

function createSentinels() {
  mkdirSync(sentinelDir, { recursive: true });
  mkdirSync(isolatedBin, { recursive: true });

  writeTextAt(
    sentinelDir,
    'git',
    [
      '#!/bin/sh',
      'set -eu',
      'log="${ROUTECODEX_RETIRED_LOG:-/dev/null}"',
      'case "${1:-}" in',
      '  hash-object|checkout-index|archive)',
      '    printf \'RETIRED_GIT:%s\\n\' "$1" >> "$log"',
      '    echo "retired Git subcommand intercepted: $1" >&2',
      '    exit 97',
      '    ;;',
      '  rev-parse)',
      '    if [ "${2:-}" = "--verify" ]; then',
      '      case "${3:-}" in',
      '        *:*)',
      '          printf \'RETIRED_GIT:rev-parse --verify blob\\n\' >> "$log"',
      '          echo "retired blob identity verification intercepted" >&2',
      '          exit 97',
      '          ;;',
      '      esac',
      '    fi',
      '    ;;',
      'esac',
      'exec "$ROUTECODEX_REAL_GIT" "$@"',
      '',
    ].join('\n'),
    0o755,
  );

  for (const tool of ['mktemp', 'tar', 'appsdk', 'shasum', 'sha256sum']) {
    writeTextAt(
      sentinelDir,
      tool,
      [
        '#!/bin/sh',
        'set -eu',
        'log="${ROUTECODEX_RETIRED_LOG:-/dev/null}"',
        `printf 'RETIRED_TOOL:${tool}\\n' >> "$log"`,
        `echo "retired snapshot/admission tool intercepted: ${tool}" >&2`,
        'exit 97',
        '',
      ].join('\n'),
      0o755,
    );
  }

  symlinkSync(realGit, join(isolatedBin, 'git'));
}

try {
  createSentinels();

  mkdirSync(repo, { recursive: true });
  mustRun('git', ['init', '-q']);
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/test']);
  mustRun('git', ['config', 'user.name', 'Hook Fixture']);
  mustRun('git', ['config', 'user.email', 'hook-fixture@example.com']);
  mustRun('git', ['config', 'commit.gpgsign', 'false']);
  mustRun('git', ['init', '--bare', '-q', originRepo], { cwd: tempRoot });

  writeText('.gitignore', 'node_modules/\n');
  writeText('README.md', '# hook fixture\n');
  writeJson('package.json', {
    scripts: { 'verify:fast': 'node scripts/verify-fast.mjs' },
  });
  copyRealityIntoFixture();

  mustRun('git', ['add', '.']);
  mustRun('git', ['commit', '-q', '-m', 'fixture initial']);
  mustRun('git', ['remote', 'add', 'origin', originRepo]);
  mustRun('git', ['push', '-q', 'origin', 'refs/heads/test:refs/heads/test']);
  const baseSha = mustRun('git', ['rev-parse', 'HEAD']).stdout.trim();

  // Positive feature commit: valid staged index content passes the real hook
  // and runs the real fast gate, while the worktree holds invalid content that
  // is not staged. The hook must select the index, not the worktree.
  writeText('data/config.json', `${JSON.stringify({ source: 'index' }, null, 2)}\n`);
  writeText('scripts/helper.mjs', 'export const helper = 1;\n');
  writeText('scripts/setup.sh', '#!/bin/sh\nset -eu\nexit 0\n');
  mustRun('git', ['add', 'data/config.json', 'scripts/helper.mjs', 'scripts/setup.sh']);
  writeText('data/config.json', '{ broken unstaged json\n');
  assert.equal(
    readFileSync(join(repo, 'data/config.json'), 'utf8'),
    '{ broken unstaged json\n',
    'fixture worktree must hold invalid content while the index holds valid content',
  );

  resetRetiredLog();
  const stagedCommit = runHook('pre-commit');
  expectStatus(stagedCommit, 0, 'pre-commit accepts valid staged content');
  assertNoRetiredMachinery('pre-commit valid index selection', stagedCommit);
  assert.equal(
    readFileSync(join(repo, 'data/config.json'), 'utf8'),
    '{ broken unstaged json\n',
    'pre-commit must not have consumed the invalid worktree content',
  );

  mustRun('git', ['commit', '-q', '-m', 'feature commit']);
  const headSha = mustRun('git', ['rev-parse', 'HEAD']).stdout.trim();

  // Positive feature push: valid pushed ref content passes while the same-path
  // worktree content is still invalid.
  resetRetiredLog();
  const pushedUpdate = runHook(
    'pre-push',
    {},
    `refs/heads/test ${headSha} refs/heads/test ${baseSha}\n`,
  );
  expectStatus(pushedUpdate, 0, 'pre-push accepts a valid existing ref');
  assertNoRetiredMachinery('pre-push existing-ref selection', pushedUpdate);
  assert.equal(
    readFileSync(join(repo, 'data/config.json'), 'utf8'),
    '{ broken unstaged json\n',
    'pre-push must not have consumed the invalid worktree content',
  );

  const pushedNewRef = runHook(
    'pre-push',
    {},
    `refs/heads/test ${headSha} refs/heads/test ${z40}\n`,
  );
  expectStatus(pushedNewRef, 0, 'pre-push accepts a valid new ref');
  assertNoRetiredMachinery('pre-push new-ref selection', pushedNewRef);

  // A representative real invalid JSON case per hook proves a nonzero verifier
  // result propagates; parser coverage itself is unchanged scoped behavior.
  writeText('data/config.json', '{ "broken": true\n');
  mustRun('git', ['add', 'data/config.json']);
  const invalidStagedJson = runHook('pre-commit');
  expectFailure(
    invalidStagedJson,
    /data\/config\.json JSON parse failed/u,
    'pre-commit propagates an invalid staged JSON failure',
  );

  const badIndex = join(tempRoot, 'bad.index');
  const badIndexEnv = { ...fixtureEnv, GIT_INDEX_FILE: badIndex };
  mustRun('git', ['read-tree', headSha], { env: badIndexEnv });
  writeText('data/pushed.json', '{ "pushed": false\n');
  mustRun('git', ['add', 'data/pushed.json'], { env: badIndexEnv });
  const badTree = mustRun('git', ['write-tree'], { env: badIndexEnv }).stdout.trim();
  const badSha = mustRun('git', ['commit-tree', badTree, '-p', headSha, '-m', 'fixture invalid json'], {
    env: {
      ...badIndexEnv,
      GIT_AUTHOR_NAME: 'Hook Fixture',
      GIT_AUTHOR_EMAIL: 'hook-fixture@example.com',
      GIT_COMMITTER_NAME: 'Hook Fixture',
      GIT_COMMITTER_EMAIL: 'hook-fixture@example.com',
    },
  }).stdout.trim();
  const invalidPushedJson = runHook(
    'pre-push',
    {},
    `refs/heads/test ${badSha} refs/heads/test ${headSha}\n`,
  );
  expectFailure(
    invalidPushedJson,
    /data\/pushed\.json JSON parse failed/u,
    'pre-push propagates an invalid pushed JSON failure',
  );

  // Cheap protected-branch behavior. Deletion on a protected ref must not be
  // mistaken for the non-protected deletion continuation below.
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const mainCommit = runHook('pre-commit');
  expectFailure(mainCommit, /commits on main are disabled/u, 'main commit protection');
  expectNoFastGate(mainCommit, 'main commit must stop before npm');
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  const masterCommit = runHook('pre-commit');
  expectFailure(masterCommit, /commits on master are disabled/u, 'master commit protection');
  expectNoFastGate(masterCommit, 'master commit must stop before npm');
  mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/test']);

  const mainPush = runHook('pre-push', {}, `refs/heads/main ${headSha} refs/heads/main ${baseSha}\n`);
  expectFailure(mainPush, /updates to refs\/heads\/main are disabled/u, 'main push protection');
  expectNoFastGate(mainPush, 'main push must stop before npm');

  const masterPush = runHook(
    'pre-push',
    {},
    `refs/heads/master ${headSha} refs/heads/master ${baseSha}\n`,
  );
  expectFailure(
    masterPush,
    /updates to refs\/heads\/master are disabled/u,
    'master push protection',
  );
  expectNoFastGate(masterPush, 'master push must stop before npm');

  const protectedDeletion = runHook(
    'pre-push',
    {},
    `refs/heads/main ${z40} refs/heads/main ${baseSha}\n`,
  );
  expectFailure(
    protectedDeletion,
    /updates to refs\/heads\/main are disabled/u,
    'protected deletion is rejected before deletion handling',
  );
  expectNoFastGate(protectedDeletion, 'protected deletion must stop before npm');

  // Every ref line is processed: a protected ref after a feature ref still fails
  // the push, and the feature ref before it still runs the fast gate.
  const featureThenProtected = runHook(
    'pre-push',
    {},
    [
      `refs/heads/test ${headSha} refs/heads/test ${baseSha}`,
      `refs/heads/main ${headSha} refs/heads/main ${baseSha}`,
      '',
    ].join('\n'),
  );
  expectFailure(
    featureThenProtected,
    /updates to refs\/heads\/main are disabled/u,
    'later protected ref is processed',
  );
  assert.match(output(featureThenProtected), /\[verify:fast\] PASS checked [1-9]\d*/u);

  // Non-protected deletion continues: deletion alone exits without content
  // checks, and a later ref in the same stdin is still processed.
  resetRetiredLog();
  const deletionOnly = runHook(
    'pre-push',
    {},
    `refs/heads/gone ${z40} refs/heads/gone ${baseSha}\n`,
  );
  expectStatus(deletionOnly, 0, 'non-protected deletion continues');
  expectNoFastGate(deletionOnly, 'deletion-only push must not run content checks');
  assert.equal(readRetiredLog(), '', 'deletion-only push used retired machinery');

  const deletionThenUpdate = runHook(
    'pre-push',
    {},
    [
      `refs/heads/gone ${z40} refs/heads/gone ${baseSha}`,
      `refs/heads/test ${headSha} refs/heads/test ${baseSha}`,
      '',
    ].join('\n'),
  );
  expectStatus(deletionThenUpdate, 0, 'a ref after a deletion is still processed');
  assertNoRetiredMachinery('post-deletion ref selection', deletionThenUpdate);

  // Required tool/package failures stay loud instead of being skipped.
  const missingNpm = runHook('pre-commit', { PATH: isolatedBin });
  expectFailure(
    missingNpm,
    /cannot run Git main protection verification/u,
    'missing npm is reported',
  );
  const packageJson = readFileSync(join(repo, 'package.json'), 'utf8');
  rmSync(join(repo, 'package.json'));
  try {
    const missingPackage = runHook('pre-commit');
    expectFailure(
      missingPackage,
      /cannot run Git main protection verification/u,
      'missing package.json is reported',
    );
  } finally {
    writeText('package.json', packageJson);
  }

  console.log('[test:git-hooks] PASS');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
