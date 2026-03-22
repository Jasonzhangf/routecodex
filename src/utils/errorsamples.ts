import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRccPath } from '../config/user-data-paths.js';

const KB = 1024;
const MB = 1024 * KB;

const DEFAULT_MAX_SAMPLE_BYTES = 256 * KB;
const DEFAULT_MAX_FILES_PER_GROUP = 5000;
const DEFAULT_MAX_BYTES_PER_GROUP = 1024 * MB;
const DEFAULT_CLIENT_TOOL_MAX_SAMPLE_BYTES = 24 * KB;
const DEFAULT_CLIENT_TOOL_MAX_FILES = 120;
const DEFAULT_CLIENT_TOOL_MAX_BYTES = 12 * MB;
const DEFAULT_PRUNE_INTERVAL_MS = 2000;

type ErrorsampleGroupBudget = {
  maxSampleBytes: number;
  maxFiles: number;
  maxBytes: number;
  pruneIntervalMs: number;
};

type GroupFileMeta = {
  path: string;
  size: number;
  mtimeMs: number;
};

const pruneState = new Map<string, { lastRunAt: number; pending: Promise<void> | null }>();

function resolveErrorsamplesRoot(): string {
  const envOverride =
    process.env.ROUTECODEX_ERRORSAMPLES_DIR ||
    process.env.RCC_ERRORSAMPLES_DIR ||
    process.env.ROUTECODEX_ERROR_SAMPLES_DIR;
  if (envOverride && String(envOverride).trim()) {
    return path.resolve(String(envOverride).trim());
  }
  return resolveRccPath('errorsamples');
}

function safeName(name: string): string {
  return String(name || 'sample').replace(/[^\w.-]/g, '_');
}

function safeStamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

function parseEnvPositiveInt(keys: string[], fallback: number, min = 1): number {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || String(raw).trim() === '') {
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    const value = Math.floor(parsed);
    if (value >= min) {
      return value;
    }
  }
  return fallback;
}

function resolveGroupBudget(group: string): ErrorsampleGroupBudget {
  const normalizedGroup = safeName(group || 'sample').toLowerCase();
  const maxSampleBytes = parseEnvPositiveInt(
    ['ROUTECODEX_ERRORSAMPLE_MAX_BYTES', 'RCC_ERRORSAMPLE_MAX_BYTES'],
    DEFAULT_MAX_SAMPLE_BYTES
  );
  const defaultMaxFiles = parseEnvPositiveInt(
    ['ROUTECODEX_ERRORSAMPLE_MAX_FILES_PER_GROUP', 'RCC_ERRORSAMPLE_MAX_FILES_PER_GROUP'],
    DEFAULT_MAX_FILES_PER_GROUP
  );
  const defaultMaxBytes = parseEnvPositiveInt(
    ['ROUTECODEX_ERRORSAMPLE_MAX_BYTES_PER_GROUP', 'RCC_ERRORSAMPLE_MAX_BYTES_PER_GROUP'],
    DEFAULT_MAX_BYTES_PER_GROUP
  );
  const pruneIntervalMs = parseEnvPositiveInt(
    ['ROUTECODEX_ERRORSAMPLE_PRUNE_INTERVAL_MS', 'RCC_ERRORSAMPLE_PRUNE_INTERVAL_MS'],
    DEFAULT_PRUNE_INTERVAL_MS,
    0
  );

  if (normalizedGroup === 'client-tool-error') {
    return {
      maxSampleBytes: parseEnvPositiveInt(
        ['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_SAMPLE_BYTES'],
        DEFAULT_CLIENT_TOOL_MAX_SAMPLE_BYTES
      ),
      maxFiles: parseEnvPositiveInt(
        ['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_FILES'],
        DEFAULT_CLIENT_TOOL_MAX_FILES
      ),
      maxBytes: parseEnvPositiveInt(
        ['ROUTECODEX_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES', 'RCC_ERRORSAMPLE_CLIENT_TOOL_MAX_BYTES'],
        DEFAULT_CLIENT_TOOL_MAX_BYTES
      ),
      pruneIntervalMs
    };
  }

  return {
    maxSampleBytes,
    maxFiles: defaultMaxFiles,
    maxBytes: defaultMaxBytes,
    pruneIntervalMs
  };
}

function serializePayloadForWrite(payload: unknown, maxSampleBytes: number): string {
  const maxBytes = Math.max(1024, Math.floor(maxSampleBytes));
  let pretty = '';
  try {
    pretty = JSON.stringify(payload, null, 2);
  } catch {
    pretty = JSON.stringify(
      {
        truncated: true,
        reason: 'payload_unserializable',
        preview: String(payload)
      },
      null,
      2
    );
  }
  if (Buffer.byteLength(pretty, 'utf8') <= maxBytes) {
    return pretty;
  }

  let compact = '';
  try {
    compact = JSON.stringify(payload);
  } catch {
    compact = '';
  }
  const originalBytes = Buffer.byteLength(compact || pretty, 'utf8');
  let previewChars = Math.max(512, Math.floor(maxBytes * 0.6));

  while (previewChars >= 256) {
    const candidate = JSON.stringify(
      {
        truncated: true,
        reason: 'payload_too_large',
        maxBytes,
        originalBytes,
        preview: (compact || pretty).slice(0, previewChars)
      },
      null,
      2
    );
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      return candidate;
    }
    previewChars = Math.floor(previewChars * 0.75);
  }

  return JSON.stringify(
    {
      truncated: true,
      reason: 'payload_too_large',
      maxBytes,
      originalBytes
    },
    null,
    2
  );
}

async function collectGroupFiles(dir: string): Promise<GroupFileMeta[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: GroupFileMeta[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(full);
      files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs || 0 });
    } catch {
      // ignore race with concurrent deletion
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return files;
}

async function pruneGroupDirectoryNow(dir: string, budget: ErrorsampleGroupBudget): Promise<void> {
  if (budget.maxFiles <= 0 || budget.maxBytes <= 0) {
    return;
  }
  const files = await collectGroupFiles(dir);
  if (files.length <= 0) {
    return;
  }

  let totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  let fileCount = files.length;
  const toDelete: string[] = [];
  for (const file of files) {
    if (fileCount <= budget.maxFiles && totalBytes <= budget.maxBytes) {
      break;
    }
    toDelete.push(file.path);
    fileCount -= 1;
    totalBytes -= Math.max(0, file.size);
  }

  if (toDelete.length <= 0) {
    return;
  }
  await Promise.all(toDelete.map((filePath) => fs.rm(filePath, { force: true })));
}

async function maybePruneGroupDirectory(
  dir: string,
  budget: ErrorsampleGroupBudget,
  options?: { force?: boolean }
): Promise<void> {
  const force = options?.force === true;
  const state = pruneState.get(dir) || { lastRunAt: 0, pending: null };
  if (state.pending) {
    await state.pending;
    return;
  }

  const now = Date.now();
  if (!force && budget.pruneIntervalMs > 0 && now - state.lastRunAt < budget.pruneIntervalMs) {
    return;
  }

  const pending = (async () => {
    await pruneGroupDirectoryNow(dir, budget);
    state.lastRunAt = Date.now();
  })().finally(() => {
    const latest = pruneState.get(dir);
    if (latest) {
      latest.pending = null;
      pruneState.set(dir, latest);
    }
  });

  state.pending = pending;
  pruneState.set(dir, state);
  await pending;
}

function isEnospc(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.toUpperCase() === 'ENOSPC';
}

export async function writeErrorsampleJson(options: {
  group: string;
  kind: string;
  payload: unknown;
}): Promise<string> {
  const root = resolveErrorsamplesRoot();
  const dir = path.join(root, safeName(options.group));
  const budget = resolveGroupBudget(options.group);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${safeName(options.kind)}-${safeStamp()}-${Math.random().toString(16).slice(2)}.json`
  );
  const serialized = serializePayloadForWrite(options.payload, budget.maxSampleBytes);

  try {
    await fs.writeFile(file, serialized, 'utf8');
  } catch (error) {
    if (!isEnospc(error)) {
      throw error;
    }
    await maybePruneGroupDirectory(dir, budget, { force: true });
    await fs.writeFile(file, serialized, 'utf8');
  }
  await maybePruneGroupDirectory(dir, budget);
  return file;
}
