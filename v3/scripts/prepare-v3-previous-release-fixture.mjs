#!/usr/bin/env node
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This real source release predates the exec-owner transfer protocol. Keep the
// migration prerequisite separate from both the candidate and installed CLI.
const sourceCommit = '3ee73753f5b638c863f0870994b9aea57ae15e87';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = mkdtempSync(join(tmpdir(), 'rcc-v3-previous-release-'));
const source = join(fixture, 'source');
const target = join(fixture, 'target');
const archive = join(fixture, 'source.tar');
const binary = join(fixture, 'rccv3');
mkdirSync(source);
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2' };
delete env.ROUTECODEX_BUILD_VERSION;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}; fixture=${fixture}`);
}

try {
  run('git', ['archive', '--format=tar', '--output', archive, sourceCommit], repo);
  run('tar', ['-xf', archive, '-C', source], repo);
  const version = JSON.parse(readFileSync(join(source, 'v3/package.json'), 'utf8')).version;
  run('cargo', ['build', '--locked', '--release', '--manifest-path', join(source, 'v3/Cargo.toml'), '-p', 'routecodex-v3-cli'], source);
  copyFileSync(join(target, 'release/rccv3'), binary);
  const result = spawnSync(binary, ['--version'], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes(version)) {
    throw new Error(`previous-release version failed: ${result.stderr || result.stdout}`);
  }
  writeFileSync(join(fixture, 'provenance.json'), `${JSON.stringify({
    source_commit: sourceCommit, version, platform: process.platform, arch: process.arch,
    binary, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  }, null, 2)}\n`);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `ROUTECODEX_V3_PREVIOUS_RELEASE_BINARY=${binary}\n`);
  }
  console.log(`ROUTECODEX_V3_PREVIOUS_RELEASE_BINARY=${binary}`);
  console.log(`previous-release provenance: ${join(fixture, 'provenance.json')}`);
} finally {
  rmSync(source, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  rmSync(archive, { force: true });
}
