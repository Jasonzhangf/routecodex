import type { Request, Response } from 'express';

export interface ClientConnectionState {
  disconnected: boolean;
}

export const CLIENT_CONNECTION_STATE_FIELD = '__clientConnectionState';

export function trackClientConnectionState(req: Request, res: Response): ClientConnectionState {
  const state: ClientConnectionState = { disconnected: false };
  const markDisconnected = () => {
    state.disconnected = true;
  };
  req.on('aborted', markDisconnected);
  res.on('close', () => {
    if (state.disconnected) {
      return;
    }
    const finished = (res as unknown as { writableFinished?: boolean }).writableFinished;
    const ended = (res as unknown as { writableEnded?: boolean }).writableEnded;
    if (!finished && !ended) {
      state.disconnected = true;
    }
  });
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
