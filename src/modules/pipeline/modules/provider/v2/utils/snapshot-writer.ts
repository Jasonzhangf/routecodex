import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

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
      url: options.url,
      headers: maskHeaders(options.headers || {}),
      ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
    };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // non-blocking
  }
}

