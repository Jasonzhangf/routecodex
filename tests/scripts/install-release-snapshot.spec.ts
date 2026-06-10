import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, test } from '@jest/globals';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('install-release-snapshot', () => {
  function runInstallReleaseSnapshot(tempHome: string) {
    execFileSync(
      process.execPath,
      ['scripts/ensure-llmswitch-mode.mjs'],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'pipe'
      }
    );

    execFileSync(
      process.execPath,
      ['scripts/install-release-snapshot.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RCC_HOME: tempHome,
          ROUTECODEX_RELEASE_SOURCE_ROOT: process.cwd()
        },
        stdio: 'pipe'
      }
    );
  }

  test('copies sharedmodule llmswitch-core dist into release snapshot', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-'));
    tempDirs.push(tempHome);
    runInstallReleaseSnapshot(tempHome);

    const currentRoot = path.join(tempHome, 'install', 'current');
    const requiredFile = path.join(
      currentRoot,
      'sharedmodule',
      'llmswitch-core',
      'dist',
      'native',
      'router-hotpath',
      'native-hub-pipeline-session-identifiers-semantics.js'
    );

    expect(fs.existsSync(requiredFile)).toBe(true);
  });

  test('writes manifest with stable release metadata', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-'));
    tempDirs.push(tempHome);
    runInstallReleaseSnapshot(tempHome);

    const manifestPath = path.join(tempHome, 'install', 'current', 'install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      kind: string;
      releaseId: string;
      version: string;
      buildMode: string;
      sourceRepoRoot: string;
      buildRepoRoot: string;
      installRoot: string;
      distCli: string;
    };

    expect(manifest.kind).toBe('routecodex-release-snapshot');
    expect(manifest.releaseId).toMatch(/^routecodex-/);
    expect(manifest.version).toBe(require(path.join(process.cwd(), 'package.json')).version);
    expect(manifest.buildMode).toBe('release');
    expect(manifest.sourceRepoRoot).toBe(process.cwd());
    expect(manifest.buildRepoRoot).toBe(process.cwd());
    expect(manifest.installRoot).toBe(path.join(tempHome, 'install'));
    expect(manifest.distCli).toBe(
      path.join(tempHome, 'install', 'releases', manifest.releaseId, 'dist', 'cli.js')
    );
  });
});
