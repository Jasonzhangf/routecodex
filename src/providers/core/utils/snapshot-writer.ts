import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeSnapshotViaHooks } from '../../../modules/llmswitch/bridge.js';

type Phase = 'provider-request' | 'provider-response' | 'provider-error';
type ClientPhase = 'client-request';

const SNAPSHOT_BASE = path.join(os.homedir(), '.routecodex', 'codex-samples');

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    // ignore mkdir errors (non-blocking snapshot)
  }
}

function normalizeRequestId(requestId?: string): string {
  if (!requestId || typeof requestId !== 'string') {
    return `req_${Date.now()}`;
  }
  const trimmed = requestId.trim();
  if (!trimmed) {
    return `req_${Date.now()}`;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
  return sanitized || `req_${Date.now()}`;
}

function resolveEndpoint(url?: string): { endpoint: string; folder: string } {
  const rawUrl = String(url || '').toLowerCase();
  if (rawUrl.includes('/responses')) {
    return { endpoint: '/v1/responses', folder: 'openai-responses' };
  }
  if (rawUrl.includes('/messages')) {
    return { endpoint: '/v1/messages', folder: 'anthropic-messages' };
  }
  return { endpoint: '/v1/chat/completions', folder: 'openai-chat' };
}

function maskHeaders(headers: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers || typeof headers !== 'object') {
    return result;
  }
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      const raw = String(v ?? '');
      const masked = raw.length > 12 ? `${raw.slice(0, 6)}****${raw.slice(-6)}` : '****';
      result[k] = masked;
    } else {
      result[k] = v;
    }
  }
  return result;
}

function buildSnapshotPayload(options: {
  stage: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  extraMeta?: Record<string, unknown>;
}) {
  return {
    meta: {
      stage: options.stage,
      version: String(process.env.ROUTECODEX_VERSION || 'dev'),
      buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString()),
      ...(options.extraMeta || {})
    },
    url: options.url,
    headers: maskHeaders(options.headers || {}),
    ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
  };
}

function fallbackFilePath(folder: string, requestId: string, stage: string): string {
  const dir = path.join(SNAPSHOT_BASE, folder);
  const safeStage = stage.replace(/[^\w.-]/g, '_');
  return path.join(dir, `${requestId}_${safeStage}.json`);
}

export async function writeProviderSnapshot(options: {
  phase: Phase;
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
}): Promise<void> {
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint || options.url);
  const stage = options.phase;
  const requestId = normalizeRequestId(options.requestId);
  const payload = buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: {
      ...(options.entryEndpoint ? { entryEndpoint: options.entryEndpoint } : {}),
      ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {})
    }
  });

  try {
    await writeSnapshotViaHooks({
      endpoint,
      stage,
      requestId,
      data: payload,
      verbosity: 'verbose'
    });
    return;
  } catch {
    try {
      await ensureDir(path.join(SNAPSHOT_BASE, folder));
      await fsp.writeFile(fallbackFilePath(folder, requestId, stage), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // non-blocking fallback failure
    }
  }
}

export async function writeProviderRetrySnapshot(options: {
  type: 'request' | 'response';
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  clientRequestId?: string;
}): Promise<void> {
  const { endpoint, folder } = resolveEndpoint(options.url);
  const stage = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
  const requestId = normalizeRequestId(options.requestId);
  const payload = buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: options.clientRequestId ? { clientRequestId: options.clientRequestId } : undefined
  });

  try {
    await writeSnapshotViaHooks({
      endpoint,
      stage,
      requestId,
      data: payload,
      verbosity: 'verbose'
    });
    return;
  } catch {
    try {
      await ensureDir(path.join(SNAPSHOT_BASE, folder));
      await fsp.writeFile(fallbackFilePath(folder, requestId, stage), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // non-blocking fallback failure
    }
  }
}

export async function writeRepairFeedbackSnapshot(options: {
  requestId: string;
  feedback: unknown;
}): Promise<void> {
  try {
    const dir = path.join(SNAPSHOT_BASE, 'openai-chat');
    await ensureDir(dir);
    const requestId = normalizeRequestId(options.requestId);
    const payload = {
      meta: {
        stage: 'repair-feedback',
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      feedback: options.feedback
    };
    await fsp.writeFile(path.join(dir, `${requestId}_repair-feedback.json`), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // non-blocking
  }
}

export async function writeClientSnapshot(options: {
  entryEndpoint: string;
  requestId: string;
  headers?: Record<string, unknown>;
  body: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const stage: ClientPhase = 'client-request';
    const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
    const requestId = normalizeRequestId(options.requestId);
    const snapshotPayload = {
      body: options.body,
      metadata: options.metadata || {}
    };
    const payload = buildSnapshotPayload({
      stage,
      data: snapshotPayload,
      headers: options.headers,
      url: endpoint,
      extraMeta: {
        entryEndpoint: endpoint,
        stream: options.metadata?.stream,
        userAgent: options.metadata?.userAgent
      }
    });
    try {
      await writeSnapshotViaHooks({
        endpoint,
        stage,
        requestId,
        data: payload,
        verbosity: 'verbose'
      });
      return;
    } catch {
      await ensureDir(path.join(SNAPSHOT_BASE, folder));
      await fsp.writeFile(fallbackFilePath(folder, requestId, stage), JSON.stringify(payload, null, 2), 'utf-8');
    }
  } catch {
    // non-blocking
  }
}
