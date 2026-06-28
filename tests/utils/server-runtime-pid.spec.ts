import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  readServerPidCache,
  resolveServerPidCachePath,
  unlinkServerPidCacheBestEffort,
  writeServerPidCache
} from '../../src/utils/server-runtime-pid.js';

describe('server runtime pid cache', () => {
  it('writes, reads, and unlinks pid cache under state/runtime-lifecycle/ports/<port>/pid.cache', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-runtime-pid-'));
    const port = 5520;

    expect(resolveServerPidCachePath(port, home)).toBe(
      path.join(home, 'state', 'runtime-lifecycle', 'ports', '5520', 'pid.cache')
    );

    writeServerPidCache({ port, pid: 4242, origin: 'start', routeCodexHomeDir: home });
    const read = readServerPidCache({ port, routeCodexHomeDir: home });
    expect(read?.pid).toBe(4242);
    expect(read?.port).toBe(5520);
    expect(read?.origin).toBe('start');

    unlinkServerPidCacheBestEffort({ port, routeCodexHomeDir: home });
    expect(fs.existsSync(resolveServerPidCachePath(port, home))).toBe(false);
  });

  it('readServerPidCache returns null when file is missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-runtime-pid-empty-'));
    expect(readServerPidCache({ port: 5555, routeCodexHomeDir: home })).toBeNull();
  });

  it('readServerPidCache returns null for malformed record', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-runtime-pid-bad-'));
    const target = resolveServerPidCachePath(5556, home);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not-json', 'utf8');
    expect(readServerPidCache({ port: 5556, routeCodexHomeDir: home })).toBeNull();
  });
});
