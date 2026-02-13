import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';

import { DeepSeekSessionPowManager } from '../../../../src/providers/core/runtime/deepseek-session-pow.js';

describe('DeepSeekSessionPowManager', () => {
  it('reuses cached chat session and returns encoded pow payload', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                id: 'session-1'
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'abc',
                  salt: 'salt',
                  difficulty: 123,
                  expire_at: 999999,
                  signature: 'sig',
                  target_path: '/api/v0/chat/completion'
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const manager = new DeepSeekSessionPowManager({
      baseUrl: 'https://chat.deepseek.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
      powMaxAttempts: 1,
      solvePow: async () => 42
    });

    const authHeaders = { authorization: 'Bearer token' };
    const firstSession = await manager.ensureChatSession(authHeaders);
    const secondSession = await manager.ensureChatSession(authHeaders);
    const encoded = await manager.createPowResponse(authHeaders);

    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;

    expect(firstSession).toBe('session-1');
    expect(secondSession).toBe('session-1');
    expect(decoded.answer).toBe(42);
    expect(decoded.challenge).toBe('abc');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when solver is not configured', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'abc',
                  salt: 'salt',
                  difficulty: 123,
                  expire_at: 999999,
                  signature: 'sig',
                  target_path: '/api/v0/chat/completion'
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const manager = new DeepSeekSessionPowManager({
      baseUrl: 'https://chat.deepseek.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
      powMaxAttempts: 1
    });

    await expect(manager.createPowResponse({ authorization: 'Bearer token' })).rejects.toMatchObject({
      code: 'DEEPSEEK_POW_SOLVE_FAILED'
    });
  });

  it('preserves millisecond expire_at for pow solver input', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'abc',
                  salt: 'salt',
                  difficulty: 123,
                  expire_at: 1770856259868,
                  signature: 'sig',
                  target_path: '/api/v0/chat/completion'
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const solvePow = jest.fn(async (input: {
      algorithm: string;
      challenge: string;
      salt: string;
      difficulty: number;
      expireAt: number;
      signature: string;
      targetPath: string;
    }) => {
      return input.expireAt === 1770856259868 ? 42 : 0;
    });

    const manager = new DeepSeekSessionPowManager({
      baseUrl: 'https://chat.deepseek.com',
      fetchImpl: fetchMock as unknown as typeof fetch,
      powMaxAttempts: 1,
      solvePow
    });

    const encoded = await manager.createPowResponse({ authorization: 'Bearer token' });
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;

    expect(solvePow).toHaveBeenCalledTimes(1);
    expect(solvePow.mock.calls[0]?.[0]?.expireAt).toBe(1770856259868);
    expect(decoded.answer).toBe(42);
  });

  it('falls back to built-in solver/wasm when configured paths are missing', () => {
    const manager = new DeepSeekSessionPowManager({
      baseUrl: 'https://chat.deepseek.com',
      solverPath: '/tmp/definitely-missing-pow-solver.mjs',
      wasmPath: '/tmp/definitely-missing-pow.wasm'
    });

    const resolvedSolverPath = (manager as any).solverPath as string | undefined;
    const resolvedWasmPath = (manager as any).wasmPath as string | undefined;

    expect(resolvedSolverPath).not.toBe('/tmp/definitely-missing-pow-solver.mjs');
    expect(resolvedWasmPath).not.toBe('/tmp/definitely-missing-pow.wasm');
    expect(typeof resolvedSolverPath === 'string' && fs.existsSync(resolvedSolverPath)).toBe(true);
    expect(typeof resolvedWasmPath === 'string' && fs.existsSync(resolvedWasmPath)).toBe(true);
  });
});
