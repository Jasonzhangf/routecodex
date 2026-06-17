import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  readRuntimeInstance,
  removeRuntimeInstance,
  resolveRuntimeInstancePath,
  updateRuntimeInstanceStatus,
  writeRuntimeInstance
} from '../../src/utils/runtime-instance-registry.js';

describe('runtime instance registry', () => {
  it('writes and reads instance.json under state/runtime-lifecycle/ports/<port>/instance.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-instance-registry-'));
    const filePath = resolveRuntimeInstancePath(5555, home);
    expect(filePath).toBe(
      path.join(home, 'state', 'runtime-lifecycle', 'ports', '5555', 'instance.json')
    );

    const record = writeRuntimeInstance({
      port: 5555,
      host: '127.0.0.1',
      command: 'node dist/index.js',
      configPath: '/tmp/config.toml',
      ownerScope: 'jest',
      routeCodexHomeDir: home
    });

    expect(record.status).toBe('declared');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = readRuntimeInstance(5555, home);
    expect(loaded?.port).toBe(5555);
    expect(loaded?.ownerScope).toBe('jest');
  });

  it('updates status and removes instance', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-instance-registry-'));
    writeRuntimeInstance({
      port: 5556,
      host: '127.0.0.1',
      command: 'node dist/index.js',
      configPath: '/tmp/config.toml',
      ownerScope: 'jest',
      routeCodexHomeDir: home
    });

    const updated = updateRuntimeInstanceStatus({
      port: 5556,
      status: 'healthy',
      routeCodexHomeDir: home
    });
    expect(updated?.status).toBe('healthy');

    expect(removeRuntimeInstance(5556, home)).toBe(true);
    expect(readRuntimeInstance(5556, home)).toBeNull();
  });
});
