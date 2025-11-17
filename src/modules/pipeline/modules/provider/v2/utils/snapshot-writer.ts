import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeSnapshotViaHooks } from '../../../../../llmswitch/bridge.js';

type Phase = 'provider-request' | 'provider-response' | 'provider-error';

function mapFolder(): string {
  // Provider层缺少明确端点上下文时，默认归入 openai-chat 目录（与既有样本保持一致）
  return 'openai-chat';
}

async function ensureDir(dir: string): Promise<void> {
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
}

function maskHeaders(headers: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers || typeof headers !== 'object') return result;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      const raw = String(v ?? '');
      const masked = raw.length > 12 ? `${raw.slice(0, 6)}****${raw.slice(-6)}` : '****';
      result[k] = masked;
    } else {
      result[k] = v as any;
    }
  }
  return result;
}

export async function writeProviderSnapshot(options: {
  phase: Phase;
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
}): Promise<void> {
  try {
    // 优先通过 llmswitch-core hooks 快照通道写入（与核心一致）
    try {
      // 解析 endpoint：从 url 推断
      const rawUrl = String(options.url || '').toLowerCase();
      const endpoint = rawUrl.includes('/responses') ? '/v1/responses' : (rawUrl.includes('/messages') ? '/v1/messages' : '/v1/chat/completions');
      const stage = options.phase; // provider-request|provider-response|provider-error
      const payload = {
        url: options.url,
        headers: maskHeaders(options.headers || {}),
        ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
      };
      await writeSnapshotViaHooks('provider', {
        endpoint,
        stage,
        requestId: options.requestId,
        data: payload,
        verbosity: 'verbose'
      });
      return;
    } catch {
      // 回退：直接写本地文件
      const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
      const folder = mapFolder();
      const dir = path.join(base, folder);
      await ensureDir(dir);
      const suffix = options.phase === 'provider-request'
        ? 'provider-request'
        : options.phase === 'provider-response'
          ? 'provider-response'
          : 'provider-error';
      const file = path.join(dir, `${options.requestId}_${suffix}.json`);
      const payload = {
        meta: {
          stage: suffix,
          version: String(process.env.ROUTECODEX_VERSION || 'dev'),
          buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
        },
        url: options.url,
        headers: maskHeaders(options.headers || {}),
        ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
      };
      await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
    }
  } catch {
    // non-blocking
  }
}

export async function writeProviderRetrySnapshot(options: {
  type: 'request' | 'response';
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
}): Promise<void> {
  try {
    try {
      const rawUrl = String(options.url || '').toLowerCase();
      const endpoint = rawUrl.includes('/responses') ? '/v1/responses' : (rawUrl.includes('/messages') ? '/v1/messages' : '/v1/chat/completions');
      const stage = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
      const payload = {
        url: options.url,
        headers: maskHeaders(options.headers || {}),
        ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
      };
      await writeSnapshotViaHooks('provider', { endpoint, stage, requestId: options.requestId, data: payload, verbosity: 'verbose' } as any);
      return;
    } catch {
      const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
      const dir = path.join(base, 'openai-chat');
      await ensureDir(dir);
      const suffix = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
      const file = path.join(dir, `${options.requestId}_${suffix}.json`);
      const payload = {
        meta: {
          stage: suffix,
          version: String(process.env.ROUTECODEX_VERSION || 'dev'),
          buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
        },
        url: options.url,
        headers: maskHeaders(options.headers || {}),
        ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
      };
      await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
    }
  } catch {
    // non-blocking
  }
}

export async function writeRepairFeedbackSnapshot(options: {
  requestId: string;
  feedback: unknown;
}): Promise<void> {
  try {
    const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
    const dir = path.join(base, 'openai-chat');
    await ensureDir(dir);
    const file = path.join(dir, `${options.requestId}_repair-feedback.json`);
    const payload = {
      meta: {
        stage: 'repair-feedback',
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      feedback: options.feedback
    };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // non-blocking
  }
}
