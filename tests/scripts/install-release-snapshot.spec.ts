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
  function writeTextFile(filePath: string, content = '') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  function createMinimalSnapshotProject() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-project-'));
    tempDirs.push(projectRoot);

    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.resolve('scripts/install-release-snapshot.mjs'),
      path.join(projectRoot, 'scripts', 'install-release-snapshot.mjs')
    );

    writeTextFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'routecodex',
          version: '0.0.0-test',
          type: 'module',
          dependencies: {
            'rcc-errorhandling': '^1.0.10',
            'rcc-llmswitch-core': 'file:sharedmodule/llmswitch-core'
          }
        },
        null,
        2
      )
    );
    writeTextFile(path.join(projectRoot, 'dist', 'cli.js'), 'export {};\n');
    writeTextFile(path.join(projectRoot, 'dist', 'index.js'), 'export {};\n');
    writeTextFile(path.join(projectRoot, 'dist', 'build-info.js'), "export const buildInfo = { mode: 'release' };\n");
    writeTextFile(path.join(projectRoot, 'config', '.keep'));
    writeTextFile(path.join(projectRoot, 'configsamples', '.keep'));
    writeTextFile(path.join(projectRoot, 'samples', 'mock-provider', '.keep'));
    writeTextFile(path.join(projectRoot, 'sharedmodule', 'llmswitch-core', 'dist', 'native', 'router_hotpath_napi.node'));
    writeTextFile(path.join(projectRoot, 'node_modules', 'rcc-llmswitch-core', 'package.json'), '{"name":"rcc-llmswitch-core"}\n');
    writeTextFile(path.join(projectRoot, 'node_modules', 'rcc-llmswitch-core', 'dist', 'native', 'router_hotpath_napi.node'));

    return projectRoot;
  }

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

  function runInstallReleaseSnapshotForProject(
    projectRoot: string,
    tempHome: string,
    extraEnv: Record<string, string> = {}
  ) {
    execFileSync(
      process.execPath,
      ['scripts/install-release-snapshot.mjs'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...extraEnv,
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
      'router_hotpath_napi.node'
    );

    expect(fs.existsSync(requiredFile)).toBe(true);
  });

  test('fails before installing current when a production dependency is missing from snapshot node_modules', () => {
    const projectRoot = createMinimalSnapshotProject();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-'));
    tempDirs.push(tempHome);

    let failed = false;
    try {
      execFileSync(
        process.execPath,
        ['scripts/install-release-snapshot.mjs'],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            RCC_HOME: tempHome,
            ROUTECODEX_RELEASE_SOURCE_ROOT: process.cwd()
          },
          stdio: 'pipe'
        }
      );
    } catch (error) {
      failed = true;
      const stderr = String((error as { stderr?: Buffer }).stderr || '');
      expect(stderr).toContain('snapshot production dependencies missing: rcc-errorhandling');
    }

    expect(failed).toBe(true);
    expect(fs.existsSync(path.join(tempHome, 'install', 'current'))).toBe(false);
  });

  test('retries interrupted snapshot copy without weakening dependency verification', () => {
    const scriptSource = fs.readFileSync(path.resolve('scripts/install-release-snapshot.mjs'), 'utf8');

    expect(scriptSource).toContain("error.code === 'EINTR'");
    expect(scriptSource).toContain('copy interrupted by EINTR, retrying');
    expect(scriptSource).toContain('removeIfExists(targetPath);');
    expect(scriptSource).toContain('verifySnapshotProductionDependencies(stagingDir);');
    expect(scriptSource).toContain('verifySnapshotRuntimeImports(stagingDir);');
  });

  test('does not prune a release directory still referenced by a live process command', () => {
    const projectRoot = createMinimalSnapshotProject();
    writeTextFile(
      path.join(projectRoot, 'node_modules', 'rcc-errorhandling', 'package.json'),
      '{"name":"rcc-errorhandling"}\n'
    );
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-'));
    tempDirs.push(tempHome);
    const releasesDir = path.join(tempHome, 'install', 'releases');
    const liveRelease = path.join(releasesDir, 'routecodex-0.0.0-test-live-old');
    const staleRelease = path.join(releasesDir, 'routecodex-0.0.0-test-stale-old');
    const recentOne = path.join(releasesDir, 'routecodex-0.0.0-test-recent-one');
    const recentTwo = path.join(releasesDir, 'routecodex-0.0.0-test-recent-two');
    for (const dir of [liveRelease, staleRelease, recentOne, recentTwo]) {
      writeTextFile(path.join(dir, 'dist', 'index.js'), 'export {};\n');
      writeTextFile(path.join(dir, 'package.json'), '{"version":"0.0.0-test"}\n');
    }
    const now = Date.now();
    fs.utimesSync(liveRelease, new Date(now - 40_000), new Date(now - 40_000));
    fs.utimesSync(staleRelease, new Date(now - 30_000), new Date(now - 30_000));
    fs.utimesSync(recentOne, new Date(now - 20_000), new Date(now - 20_000));
    fs.utimesSync(recentTwo, new Date(now - 10_000), new Date(now - 10_000));

    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-fake-ps-'));
    tempDirs.push(fakeBin);
    const fakePs = path.join(fakeBin, 'ps');
    writeTextFile(
      fakePs,
      [
        '#!/usr/bin/env node',
        `console.log('/opt/homebrew/bin/node ${liveRelease}/dist/index.js config/modules.json');`,
        ''
      ].join('\n')
    );
    fs.chmodSync(fakePs, 0o755);

    runInstallReleaseSnapshotForProject(projectRoot, tempHome, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
    });

    expect(fs.existsSync(liveRelease)).toBe(true);
    expect(fs.existsSync(recentOne)).toBe(true);
    expect(fs.existsSync(recentTwo)).toBe(true);
    expect(fs.existsSync(staleRelease)).toBe(false);
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
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.buildMode).toBe('release');
    expect(manifest.sourceRepoRoot).toBe(process.cwd());
    expect(manifest.buildRepoRoot).toBe(process.cwd());
    expect(manifest.installRoot).toBe(path.join(tempHome, 'install'));
    expect(manifest.distCli).toBe(
      path.join(tempHome, 'install', 'releases', manifest.releaseId, 'dist', 'cli.js')
    );
  });
});
