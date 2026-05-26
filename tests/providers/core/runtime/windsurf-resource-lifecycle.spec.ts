import { describe, expect, test, jest } from '@jest/globals';
import {
  closeGrpcSessionResource,
  closeGrpcSessionPoolEntry,
  closeAllGrpcSessionPoolEntries,
  collectGrpcSessionCloseFailureReasons,
  assertGrpcSessionCloseSucceeded,
  assertGrpcSessionPoolCloseSucceeded,
  assertAllGrpcSessionPoolEntriesClosed,
  getOrCreateGrpcSession,
  terminateStaleManagedGrpcRuntimes,
  type WindsurfGrpcSessionResource,
  type WindsurfGrpcSessionCacheable,
} from '../../../../src/providers/core/runtime/windsurf/resource-lifecycle-block.js';

// --- closeGrpcSessionResource ---

describe('resource-lifecycle / closeGrpcSessionResource', () => {
  function makeSession(opts?: { closeThrows?: boolean; destroyThrows?: boolean }): WindsurfGrpcSessionResource {
    return {
      close: opts?.closeThrows ? (() => { throw new Error('close failed'); }) as unknown as typeof closeGrpcSessionResource extends (s: infer S) => unknown ? S['close'] : never : jest.fn(),
      destroy: opts?.destroyThrows ? (() => { throw new Error('destroy failed'); }) as unknown as typeof closeGrpcSessionResource extends (s: infer S) => unknown ? S['destroy'] : never : jest.fn(),
    } as unknown as WindsurfGrpcSessionResource;
  }

  test('closes and destroys successfully', () => {
    const close = jest.fn();
    const destroy = jest.fn();
    const result = closeGrpcSessionResource({ close, destroy });

    expect(close).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(result).toEqual({
      closeAttempted: true,
      closeSucceeded: true,
      destroyAttempted: true,
      destroySucceeded: true,
    });
  });

  test('records close error when close throws', () => {
    const close = () => { throw new Error('close error'); };
    const destroy = jest.fn();
    const result = closeGrpcSessionResource({ close, destroy } as unknown as WindsurfGrpcSessionResource);

    expect(result.closeSucceeded).toBe(false);
    expect(result.closeError).toBe('close error');
    expect(result.destroySucceeded).toBe(true);
  });

  test('records destroy error when destroy throws', () => {
    const close = jest.fn();
    const destroy = () => { throw new Error('destroy error'); };
    const result = closeGrpcSessionResource({ close, destroy } as unknown as WindsurfGrpcSessionResource);

    expect(result.destroySucceeded).toBe(false);
    expect(result.destroyError).toBe('destroy error');
    expect(result.closeSucceeded).toBe(true);
  });
});

// --- closeGrpcSessionPoolEntry ---

describe('resource-lifecycle / closeGrpcSessionPoolEntry', () => {
  test('closes existing entry and removes from pool', () => {
    const close = jest.fn();
    const destroy = jest.fn();
    const pool = new Map([['key1', { close, destroy } as unknown as import('node:http2').ClientHttp2Session]]);

    const result = closeGrpcSessionPoolEntry({ pool, key: 'key1' });
    expect(result.existed).toBe(true);
    expect(result.closeSucceeded).toBe(true);
    expect(pool.has('key1')).toBe(false);
  });

  test('returns no-op for missing key', () => {
    const pool = new Map<string, import('node:http2').ClientHttp2Session>();
    const result = closeGrpcSessionPoolEntry({ pool, key: 'nonexistent' });

    expect(result.existed).toBe(false);
    expect(result.closeAttempted).toBe(false);
  });
});

// --- closeAllGrpcSessionPoolEntries ---

describe('resource-lifecycle / closeAllGrpcSessionPoolEntries', () => {
  test('closes all entries in pool', () => {
    const pool = new Map([
      ['k1', { close: jest.fn(), destroy: jest.fn() } as unknown as import('node:http2').ClientHttp2Session],
      ['k2', { close: jest.fn(), destroy: jest.fn() } as unknown as import('node:http2').ClientHttp2Session],
    ]);

    const results = closeAllGrpcSessionPoolEntries(pool);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.closeSucceeded)).toBe(true);
    expect(pool.size).toBe(0);
  });

  test('returns empty array for empty pool', () => {
    const results = closeAllGrpcSessionPoolEntries(new Map());
    expect(results).toEqual([]);
  });
});

// --- collectGrpcSessionCloseFailureReasons ---

describe('resource-lifecycle / collectGrpcSessionCloseFailureReasons', () => {
  test('collects non-empty error strings', () => {
    const reasons = collectGrpcSessionCloseFailureReasons({
      closeError: 'connection refused',
      destroyError: '',
    });
    expect(reasons).toEqual(['connection refused']);
  });

  test('collects both errors', () => {
    const reasons = collectGrpcSessionCloseFailureReasons({
      closeError: 'close failed',
      destroyError: 'destroy failed',
    });
    expect(reasons).toEqual(['close failed', 'destroy failed']);
  });

  test('returns empty when no errors', () => {
    const reasons = collectGrpcSessionCloseFailureReasons({
      closeError: undefined,
      destroyError: undefined,
    });
    expect(reasons).toEqual([]);
  });
});

// --- assertGrpcSessionCloseSucceeded ---

describe('resource-lifecycle / assertGrpcSessionCloseSucceeded', () => {
  const createError = (msg: string) => new Error(msg);

  test('passes when both close and destroy succeed', () => {
    expect(() => assertGrpcSessionCloseSucceeded({
      result: { closeAttempted: true, closeSucceeded: true, destroyAttempted: true, destroySucceeded: true },
      createError: createError as never,
      scopeLabel: 'session-1',
    })).not.toThrow();
  });

  test('throws on close failure', () => {
    expect(() => assertGrpcSessionCloseSucceeded({
      result: { closeAttempted: true, closeSucceeded: false, destroyAttempted: true, destroySucceeded: true, closeError: 'timeout' },
      createError: createError as never,
      scopeLabel: 'session-2',
    })).toThrow(/session-2.*timeout/);
  });
});

// --- assertGrpcSessionPoolCloseSucceeded ---

describe('resource-lifecycle / assertGrpcSessionPoolCloseSucceeded', () => {
  const createError = (msg: string) => new Error(msg);

  test('passes for non-existent key', () => {
    expect(() => assertGrpcSessionPoolCloseSucceeded({
      result: { key: 'missing', existed: false, closeAttempted: false, closeSucceeded: false, destroyAttempted: false, destroySucceeded: false },
      createError: createError as never,
    })).not.toThrow();
  });

  test('throws for existing entry with failed close', () => {
    expect(() => assertGrpcSessionPoolCloseSucceeded({
      result: { key: 'bad', existed: true, closeAttempted: true, closeSucceeded: false, destroyAttempted: true, destroySucceeded: false, closeError: 'refused' },
      createError: createError as never,
    })).toThrow();
  });
});

// --- assertAllGrpcSessionPoolEntriesClosed ---

describe('resource-lifecycle / assertAllGrpcSessionPoolEntriesClosed', () => {
  const createError = (msg: string) => new Error(msg);

  test('passes when all entries close successfully', () => {
    expect(() => assertAllGrpcSessionPoolEntriesClosed({
      results: [
        { key: 'k1', existed: true, closeAttempted: true, closeSucceeded: true, destroyAttempted: true, destroySucceeded: true },
        { key: 'k2', existed: false, closeAttempted: false, closeSucceeded: false, destroyAttempted: false, destroySucceeded: false },
      ],
      createError: createError as never,
    })).not.toThrow();
  });

  test('throws on first failed entry', () => {
    expect(() => assertAllGrpcSessionPoolEntriesClosed({
      results: [
        { key: 'k1', existed: true, closeAttempted: true, closeSucceeded: true, destroyAttempted: true, destroySucceeded: true },
        { key: 'k2', existed: true, closeAttempted: true, closeSucceeded: false, destroyAttempted: true, destroySucceeded: true, closeError: 'broken pipe' },
      ],
      createError: createError as never,
    })).toThrow(/broken pipe/);
  });
});

// --- getOrCreateGrpcSession ---

describe('resource-lifecycle / getOrCreateGrpcSession', () => {
  function makeCacheableSession(overrides: Partial<WindsurfGrpcSessionCacheable> = {}): WindsurfGrpcSessionCacheable & { onCalls: string[] } {
    const events: Record<string, (...args: unknown[]) => void> = {};
    const session = {
      close: jest.fn(),
      destroy: jest.fn(),
      destroyed: false,
      closed: false,
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => { events[event] = handler; }),
      unref: jest.fn(),
      ...overrides,
    } as unknown as WindsurfGrpcSessionCacheable & { onCalls: string[] };
    return session;
  }

  test('returns existing session when valid', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const session = makeCacheableSession();
    pool.set('existing', session);

    const result = getOrCreateGrpcSession({
      pool,
      key: 'existing',
      connect: jest.fn(),
      createError: (msg: string) => new Error(msg),
    });

    expect(result).toBe(session);
  });

  test('creates new session when key is missing', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const newSession = makeCacheableSession();
    const connect = jest.fn().mockReturnValue(newSession);

    const result = getOrCreateGrpcSession({
      pool,
      key: 'new',
      connect,
      createError: (msg: string) => new Error(msg),
    });

    expect(result).toBe(newSession);
    expect(pool.get('new')).toBe(newSession);
    expect(newSession.unref).toHaveBeenCalled();
  });

  test('removes stale session with destroyed=true and creates new', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const stale = makeCacheableSession({ destroyed: true });
    pool.set('key', stale);
    const fresh = makeCacheableSession();
    const connect = jest.fn().mockReturnValue(fresh);

    const result = getOrCreateGrpcSession({
      pool,
      key: 'key',
      connect,
      createError: (msg: string) => new Error(msg),
    });

    expect(result).toBe(fresh);
    expect(connect).toHaveBeenCalled();
  });

  test('registers error and close handlers on new session', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const session = makeCacheableSession();
    const connect = jest.fn().mockReturnValue(session);

    getOrCreateGrpcSession({
      pool,
      key: 'key-watch',
      connect,
      createError: (msg: string) => new Error(msg),
    });

    expect(session.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(session.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  test('error handler removes session from pool', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const session = makeCacheableSession();
    const connect = jest.fn().mockReturnValue(session);

    getOrCreateGrpcSession({
      pool,
      key: 'key-err',
      connect,
      createError: (msg: string) => new Error(msg),
    });

    expect(pool.has('key-err')).toBe(true);

    // Simulate error event
    const errorHandler = session.on.mock.calls.find((c: string[]) => c[0] === 'error')?.[1];
    errorHandler?.(new Error('connection lost'));
    
    expect(pool.has('key-err')).toBe(false);
  });

  test('close handler removes session from pool', () => {
    const pool = new Map<string, WindsurfGrpcSessionCacheable>();
    const session = makeCacheableSession();
    const connect = jest.fn().mockReturnValue(session);

    getOrCreateGrpcSession({
      pool,
      key: 'key-close',
      connect,
      createError: (msg: string) => new Error(msg),
    });

    const closeHandler = session.on.mock.calls.find((c: string[]) => c[0] === 'close')?.[1];
    closeHandler?.();
    
    expect(pool.has('key-close')).toBe(false);
  });
});

// --- terminateStaleManagedGrpcRuntimes ---

describe('resource-lifecycle / terminateStaleManagedGrpcRuntimes', () => {
  test('terminates stale runtimes excluding the kept port', () => {
    const runtimes = [
      { pid: 1001, lsPort: 42001 },
      { pid: 1002, lsPort: 42002 },
      { pid: 1003, lsPort: 42003 },
    ];
    const terminateRuntime = jest.fn().mockReturnValue({ exited: true });
    const logResult = jest.fn();

    const results = terminateStaleManagedGrpcRuntimes({
      key: 'ws-pro-1',
      runtimes,
      keepPort: 42002,
      terminateRuntime,
      logResult,
    });

    expect(results).toHaveLength(2);
    expect(terminateRuntime).toHaveBeenCalledWith(1001, 42001);
    expect(terminateRuntime).toHaveBeenCalledWith(1003, 42003);
    expect(terminateRuntime).not.toHaveBeenCalledWith(1002, 42002);
    expect(logResult).toHaveBeenCalledWith('managedLs.staleTerm', expect.any(Object));
  });

  test('skips runtimes without pid', () => {
    const runtimes = [
      { pid: 1001, lsPort: 42001 },
      { pid: undefined, lsPort: 42002 },
    ];
    const terminateRuntime = jest.fn().mockReturnValue({ exited: true });

    const results = terminateStaleManagedGrpcRuntimes({
      key: 'ws-pro-1',
      runtimes,
      keepPort: undefined,
      terminateRuntime,
    });

    expect(results).toHaveLength(1);
    expect(terminateRuntime).toHaveBeenCalledWith(1001, 42001);
  });

  test('handles empty runtime list', () => {
    const results = terminateStaleManagedGrpcRuntimes({
      key: 'ws-pro-1',
      runtimes: [],
      terminateRuntime: jest.fn(),
    });
    expect(results).toEqual([]);
  });
});
