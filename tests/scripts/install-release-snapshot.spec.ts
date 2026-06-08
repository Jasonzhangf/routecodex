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
  test('copies sharedmodule llmswitch-core dist into release snapshot', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-release-snapshot-'));
    tempDirs.push(tempHome);

    execFileSync(
      process.execPath,
      ['scripts/install-release-snapshot.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RCC_HOME: tempHome
        },
        stdio: 'pipe'
      }
    );

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
});
