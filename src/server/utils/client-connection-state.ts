import type { Request, Response } from 'express';

export interface ClientConnectionState {
  disconnected: boolean;
}

export const CLIENT_CONNECTION_STATE_FIELD = '__clientConnectionState';
const CLIENT_CONNECTION_ABORT_SIGNAL = Symbol('routecodex.clientConnectionAbortSignal');

function buildClientDisconnectedError(reason: string): Error & { code: string; name: string } {
  return Object.assign(new Error(reason), {
    code: 'CLIENT_DISCONNECTED',
    name: 'AbortError'
  });
}

function readHeaderValue(headers: Request['headers'], name: string): string | undefined {
  const raw = headers[name];
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry.trim();
      }
    }
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

function resolveClientTimeoutHintMs(req: Request): number | undefined {
  const stainlessTimeout = parsePositiveInteger(readHeaderValue(req.headers, 'x-stainless-timeout'));
  if (stainlessTimeout !== undefined) {
    return stainlessTimeout;
  }
  const genericTimeout = parsePositiveInteger(readHeaderValue(req.headers, 'x-request-timeout-ms'));
  if (genericTimeout !== undefined) {
    return genericTimeout;
  }
  return undefined;
}

export function trackClientConnectionState(req: Request, res: Response): ClientConnectionState {
  const state: ClientConnectionState = { disconnected: false };
  const controller = new AbortController();
  Object.defineProperty(state, CLIENT_CONNECTION_ABORT_SIGNAL, {
    value: controller.signal,
    enumerable: false,
    configurable: false,
    writable: false
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  const clearTimeoutHandle = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };
  const markDisconnected = (reason = 'CLIENT_DISCONNECTED') => {
    state.disconnected = true;
    clearTimeoutHandle();
    try {
      if (!controller.signal.aborted) {
        controller.abort(buildClientDisconnectedError(reason));
      }
    } catch {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  };
  req.on('aborted', () => markDisconnected('CLIENT_REQUEST_ABORTED'));
  res.on('finish', clearTimeoutHandle);
  res.on('close', () => {
    clearTimeoutHandle();
    if (state.disconnected) {
      return;
    }
    const finished = (res as unknown as { writableFinished?: boolean }).writableFinished;
    const ended = (res as unknown as { writableEnded?: boolean }).writableEnded;
    if (!finished && !ended) {
      markDisconnected('CLIENT_RESPONSE_CLOSED');
    }
  });
  const clientTimeoutHintMs = resolveClientTimeoutHintMs(req);
  if (clientTimeoutHintMs && clientTimeoutHintMs > 0) {
    // Many SDK clients keep retrying on local timeout without always closing the socket immediately.
    // Respect the advertised timeout to stop server-side auto-followups once the client is no longer waiting.
    const deadlineMs = clientTimeoutHintMs + 250;
    timeoutHandle = setTimeout(() => {
      const finished = (res as unknown as { writableFinished?: boolean }).writableFinished;
      const ended = (res as unknown as { writableEnded?: boolean }).writableEnded;
      if (!finished && !ended) {
        markDisconnected('CLIENT_TIMEOUT_HINT_EXPIRED');
      }
      clearTimeoutHandle();
    }, deadlineMs);
    timeoutHandle.unref?.();
  }
  return state;
}

export function extractClientConnectionState(
  metadata?: Record<string, unknown>
): ClientConnectionState | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const bag = metadata as { clientConnectionState?: unknown };
  const raw = bag.clientConnectionState;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = raw as { disconnected?: unknown };
    if (typeof candidate.disconnected === 'boolean') {
      return raw as ClientConnectionState;
    }
  }
  return undefined;
}

export function getClientConnectionAbortSignal(
  source?: ClientConnectionState | Record<string, unknown>
): AbortSignal | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const direct = Reflect.get(source as object, CLIENT_CONNECTION_ABORT_SIGNAL);
  if (direct && typeof direct === 'object' && 'aborted' in (direct as object)) {
    return direct as AbortSignal;
  }
  const state = extractClientConnectionState(source as Record<string, unknown>);
  if (!state) {
    return undefined;
  }
  const nested = Reflect.get(state as object, CLIENT_CONNECTION_ABORT_SIGNAL);
  return nested && typeof nested === 'object' && 'aborted' in (nested as object)
    ? (nested as AbortSignal)
    : undefined;
}

export function applyClientConnectionStateToContext(
  metadata: Record<string, unknown> | undefined,
  adapterContext: Record<string, unknown>
): void {
  const state = extractClientConnectionState(metadata);
  if (state) {
    adapterContext.clientConnectionState = state;
    adapterContext.clientDisconnected = state.disconnected === true;
    return;
  }
  if (!metadata || typeof metadata !== 'object') {
    return;
  }
  const raw = (metadata as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    adapterContext.clientDisconnected = true;
  } else if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    adapterContext.clientDisconnected = true;
  }
}
