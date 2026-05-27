#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const testPaths = [
  'tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts',
  'tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts',
  'tests/sharedmodule/virtual-router-quota-view-second-center-native.spec.ts',
  'tests/sharedmodule/virtual-router-last-provider-quota-view-native.spec.ts',
  'tests/sharedmodule/virtual-router-quota-resetat-multikey-native.spec.ts',
  'tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts',
  'tests/sharedmodule/virtual-router-cross-session-health-pollution.red.spec.ts',
  'tests/sharedmodule/virtual-router-health-last-provider.spec.ts',
  'tests/servertool/virtual-router-engine-update-deps.spec.ts'
];

const result = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    './node_modules/jest/bin/jest.js',
    '--runInBand',
    '--runTestsByPath',
    ...testPaths
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
);

if (result.status !== 0) {
  throw new Error('virtual-router quota/health shadow regression failed');
}

console.log('[virtual-router-quota-health-shadow-regression] OK');
