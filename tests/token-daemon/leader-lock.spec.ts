import fs from 'fs/promises';
import { describe, expect, it, jest } from '@jest/globals';

import {
  getTokenManagerLeaderFilePath,
  releaseTokenManagerLeader,
  tryAcquireTokenManagerLeader
} from '../../src/token-daemon/leader-lock.js';

function createFsError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe('token daemon leader lock non-blocking observability', () => {
  it('logs and throttles leader acquisition write failures', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const readFileSpy = jest.spyOn(fs, 'readFile').mockRejectedValue(createFsError('ENOENT', 'missing'));
    const writeFileSpy = jest.spyOn(fs, 'writeFile').mockRejectedValue(createFsError('EACCES', 'denied'));

    const first = await tryAcquireTokenManagerLeader('owner-a');
    const second = await tryAcquireTokenManagerLeader('owner-a');

    expect(first.isLeader).toBe(false);
    expect(second.isLeader).toBe(false);
    expect(mkdirSpy).toHaveBeenCalled();
    expect(readFileSpy).toHaveBeenCalled();
    expect(writeFileSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=leader_acquire');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=write_leader');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain(getTokenManagerLeaderFilePath());

    warnSpy.mockRestore();
    mkdirSpy.mockRestore();
    readFileSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it('logs release failures without blocking caller', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const leaderInfo = {
      ownerId: 'owner-release',
      pid: process.pid,
      startedAt: Date.now()
    };
    const readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(leaderInfo) as any);
    const unlinkSpy = jest.spyOn(fs, 'unlink').mockRejectedValue(createFsError('EACCES', 'cannot unlink'));

    await expect(releaseTokenManagerLeader('owner-release')).resolves.toBeUndefined();

    expect(readFileSpy).toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=leader_release');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=release_leader');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain(getTokenManagerLeaderFilePath());

    warnSpy.mockRestore();
    readFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });
});
