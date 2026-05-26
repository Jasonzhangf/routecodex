import type http2 from 'node:http2';

export type WindsurfGrpcSessionResource = Pick<http2.ClientHttp2Session, 'close' | 'destroy'>;

export type WindsurfGrpcSessionCloseResult = {
  closeAttempted: boolean;
  closeSucceeded: boolean;
  destroyAttempted: boolean;
  destroySucceeded: boolean;
  closeError?: string;
  destroyError?: string;
};

export type WindsurfGrpcSessionPoolCloseResult = WindsurfGrpcSessionCloseResult & {
  key: string;
  existed: boolean;
};

type WindsurfDisposeErrorFactory = (message: string, fields: Record<string, unknown>) => Error;

export type WindsurfGrpcSessionCacheable = Pick<http2.ClientHttp2Session, 'close' | 'destroy'> & {
  destroyed?: boolean;
  closed?: boolean;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  unref?: () => void;
};

export function closeGrpcSessionResource(session: WindsurfGrpcSessionResource): WindsurfGrpcSessionCloseResult {
  const result: WindsurfGrpcSessionCloseResult = {
    closeAttempted: true,
    closeSucceeded: false,
    destroyAttempted: true,
    destroySucceeded: false,
  };
  try {
    session.close();
    result.closeSucceeded = true;
  } catch (error) {
    result.closeError = error instanceof Error ? error.message : String(error);
  }
  try {
    session.destroy();
    result.destroySucceeded = true;
  } catch (error) {
    result.destroyError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function closeGrpcSessionPoolEntry(args: {
  pool: Map<string, http2.ClientHttp2Session>;
  key: string;
}): WindsurfGrpcSessionPoolCloseResult {
  const session = args.pool.get(args.key);
  if (!session) {
    return {
      key: args.key,
      existed: false,
      closeAttempted: false,
      closeSucceeded: false,
      destroyAttempted: false,
      destroySucceeded: false,
    };
  }
  const result = closeGrpcSessionResource(session);
  args.pool.delete(args.key);
  return {
    key: args.key,
    existed: true,
    ...result,
  };
}

export function closeAllGrpcSessionPoolEntries(pool: Map<string, http2.ClientHttp2Session>): WindsurfGrpcSessionPoolCloseResult[] {
  const results: WindsurfGrpcSessionPoolCloseResult[] = [];
  for (const key of Array.from(pool.keys())) {
    results.push(closeGrpcSessionPoolEntry({ pool, key }));
  }
  return results;
}

export function collectGrpcSessionCloseFailureReasons(result: Pick<WindsurfGrpcSessionCloseResult, 'closeError' | 'destroyError'>): string[] {
  return [result.closeError, result.destroyError].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function assertGrpcSessionCloseSucceeded(args: {
  result: WindsurfGrpcSessionCloseResult;
  createError: WindsurfDisposeErrorFactory;
  scopeLabel: string;
}): void {
  if (args.result.closeSucceeded && args.result.destroySucceeded) {
    return;
  }
  const reasons = collectGrpcSessionCloseFailureReasons(args.result);
  throw args.createError(
    `[windsurf] grpc session dispose failed${args.scopeLabel ? ` for ${args.scopeLabel}` : ''}: ${reasons.join(' | ') || 'unknown close/destroy failure'}`,
    {
      code: 'WINDSURF_RESOURCE_DISPOSE_FAILED',
      status: 500,
      retryable: false,
    },
  );
}

export function assertGrpcSessionPoolCloseSucceeded(args: {
  result: WindsurfGrpcSessionPoolCloseResult;
  createError: WindsurfDisposeErrorFactory;
}): void {
  if (!args.result.existed) {
    return;
  }
  assertGrpcSessionCloseSucceeded({
    result: args.result,
    createError: args.createError,
    scopeLabel: args.result.key,
  });
}

export function assertAllGrpcSessionPoolEntriesClosed(args: {
  results: WindsurfGrpcSessionPoolCloseResult[];
  createError: WindsurfDisposeErrorFactory;
}): void {
  const failure = args.results.find((result) => result.existed && (!result.closeSucceeded || !result.destroySucceeded));
  if (!failure) {
    return;
  }
  assertGrpcSessionPoolCloseSucceeded({
    result: failure,
    createError: args.createError,
  });
}

export function getOrCreateGrpcSession(args: {
  pool: Map<string, WindsurfGrpcSessionCacheable>;
  key: string;
  connect: () => WindsurfGrpcSessionCacheable;
  createError: WindsurfDisposeErrorFactory;
}): WindsurfGrpcSessionCacheable {
  const existing = args.pool.get(args.key);
  if (existing && existing.destroyed !== true && existing.closed !== true) {
    return existing;
  }
  const session = args.connect();
  session.on?.('error', () => {
    if (args.pool.get(args.key) === session) {
      args.pool.delete(args.key);
    }
  });
  session.on?.('close', () => {
    if (args.pool.get(args.key) === session) {
      args.pool.delete(args.key);
    }
  });
  try {
    session.unref?.();
  } catch (error) {
    if (args.pool.get(args.key) === session) {
      args.pool.delete(args.key);
    }
    throw args.createError(
      `[windsurf] grpc session unref failed for ${args.key}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'WINDSURF_RESOURCE_DISPOSE_FAILED',
        status: 500,
        retryable: false,
      },
    );
  }
  args.pool.set(args.key, session);
  return session;
}

export async function waitForManagedGrpcPortReady(args: {
  port: number;
  timeoutMs: number;
  connect: (port: number) => WindsurfGrpcSessionCacheable;
  closeSession: (session: WindsurfGrpcSessionCacheable) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  createError: WindsurfDisposeErrorFactory;
}): Promise<void> {
  const now = args.now || (() => Date.now());
  const started = now();
  let lastError: unknown = null;
  while (now() - started < args.timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const session = args.connect(args.port);
        const timer = setTimeout(() => {
          args.closeSession(session);
          reject(new Error('timeout'));
        }, 1000);
        session.on?.('connect', () => {
          clearTimeout(timer);
          args.closeSession(session);
          resolve();
        });
        session.on?.('error', (error: unknown) => {
          clearTimeout(timer);
          args.closeSession(session);
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await args.sleep(250);
    }
  }
  throw args.createError(
    `[windsurf] managed LS port ${args.port} not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 503,
      retryable: true,
    },
  );
}

export function terminateStaleManagedGrpcRuntimes<RuntimeOptions extends { pid?: number; lsPort?: number }>(args: {
  key: string;
  runtimes: RuntimeOptions[];
  keepPort?: number;
  terminateRuntime: (pid: number, port?: number) => Record<string, unknown>;
  logResult?: (event: 'managedLs.staleTerm' | 'managedLs.staleTermUnconfirmed', details: Record<string, unknown>) => void;
}): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const runtime of args.runtimes) {
    const pid = runtime.pid;
    if (!pid || (args.keepPort && runtime.lsPort === args.keepPort)) continue;
    const result = args.terminateRuntime(pid, runtime.lsPort);
    results.push(result);
    const exited = result.exited === true;
    args.logResult?.(exited ? 'managedLs.staleTerm' : 'managedLs.staleTermUnconfirmed', {
      key: args.key,
      keepPort: args.keepPort,
      ...result,
    });
  }
  return results;
}
