import path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { FilterStage } from '../types.js';
import { resolveRccSnapshotsDirFromEnv } from '../../runtime/user-data-paths.js';

function mapEndpointToFolder(ep?: string): string {
  const e = String(ep || '').trim().toLowerCase();
  if (e.includes('/v1/responses') || e.includes('/responses.submit')) return 'openai-responses';
  if (e.includes('/v1/messages')) return 'anthropic-messages';
  return 'openai-chat';
}

function isSnapshotEnabled(): boolean {
  const v = String(process?.env?.RCC_FILTER_SNAPSHOT || process?.env?.RCC_HOOKS_VERBOSITY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'verbose';
}

function sanitizeToken(value: string, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_') || fallback;
}

function toErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

async function writeUniqueFile(
  dir: string,
  baseName: string,
  contents: string
): Promise<void> {
  const parsed = path.parse(baseName);
  const ext = parsed.ext || '.json';
  const stem = parsed.name || 'snapshot';
  for (let i = 0; i < 64; i += 1) {
    const name = i === 0 ? `${stem}${ext}` : `${stem}_${i}${ext}`;
    try {
      await fsp.writeFile(path.join(dir, name), contents, { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (error) {
      if (toErrorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  const fallback = `${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  await fsp.writeFile(path.join(dir, fallback), contents, 'utf-8');
}

export async function writeFilterSnapshot(options: {
  requestId?: string;
  endpoint?: string;
  profile?: string;
  stage: FilterStage;
  name?: string;   // filter name
  tag?: string;    // begin/after/map_before/map_after/end
  data: unknown;
}): Promise<void> {
  try {
    if (!isSnapshotEnabled()) return;
    const rid = sanitizeToken(options.requestId || '', `req_${Date.now()}`);
    const base = resolveRccSnapshotsDirFromEnv();
    const folder = mapEndpointToFolder(options.endpoint);
    const provider = sanitizeToken(options.profile || '', '__pending__');
    const dir = path.join(base, folder, provider, rid);
    await fsp.mkdir(dir, { recursive: true });
    const parts = ['filters', options.stage.replace(/\s+/g, ''), options.tag || (options.name ? `after_${options.name}` : 'after')]
      .filter(Boolean)
      .join('_');
    const file = `${sanitizeToken(parts, 'filters')}.json`;
    const payload = {
      meta: {
        requestId: rid,
        stage: options.stage,
        name: options.name,
        tag: options.tag,
        profile: options.profile,
        endpoint: options.endpoint,
        ts: new Date().toISOString()
      },
      data: options.data
    };
    await writeUniqueFile(dir, file, JSON.stringify(payload, null, 2));
  } catch { /* ignore snapshot errors */ }
}
