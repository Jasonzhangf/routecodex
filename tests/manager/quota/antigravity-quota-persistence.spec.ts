import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  loadAntigravitySnapshotFromDisk,
  saveAntigravitySnapshotToDisk
} from '../../../src/manager/modules/quota/antigravity-quota-persistence.js';

async function createTempHome(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('antigravity quota persistence paths', () => {
  it('reads legacy snapshot when primary state file is absent', async () => {
    const home = await createTempHome('quota-state-read-');
    const legacyPath = path.join(home, '.routecodex', 'state', 'quota', 'antigravity.json');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify(
        {
          'antigravity://alias/model': {
            remainingFraction: 0.5,
            fetchedAt: 123
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const snapshot = loadAntigravitySnapshotFromDisk(() => home);
    expect(snapshot['antigravity://alias/model']?.remainingFraction).toBe(0.5);
  });

  it('always writes the snapshot into ~/.rcc even when legacy state exists', async () => {
    const home = await createTempHome('quota-state-write-');
    const legacyPath = path.join(home, '.routecodex', 'state', 'quota', 'antigravity.json');
    const primaryPath = path.join(home, '.rcc', 'state', 'quota', 'antigravity.json');

    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"legacy":true}\n', 'utf8');

    await saveAntigravitySnapshotToDisk(() => home, {
      'antigravity://alias/model': {
        remainingFraction: 0.75,
        fetchedAt: 456
      }
    });

    const primaryContent = await fs.readFile(primaryPath, 'utf8');
    expect(primaryContent).toContain('"remainingFraction": 0.75');
    expect(await fs.readFile(legacyPath, 'utf8')).toContain('"legacy":true');
  });
});
