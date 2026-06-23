// 429 detection, suppression, and purge for provider snapshots
// feature_id: snapshot.stage_contract

import fsp from 'fs/promises';
import path from 'path';
import { resolveRccSnapshotsDirFromEnv } from '../../config/user-data-paths.js';
import { toFiniteNumber, toNonEmptyString, toErrorCode, normalizeRequestId, normalizeProviderToken, resolveEndpoint, logSnapshotNonBlockingError } from './provider-utils.js';

function isRateLimitCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  const upper = code.toUpperCase();
  return (
    upper === 'HTTP_429'
    || upper.includes('RATE_LIMIT')
    || upper.includes('TOO_MANY_REQUEST')
    || upper.includes('429')
  );
}

function read429HintFromSnapshotPayload(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new WeakSet<object>();
  let steps = 0;

  while (queue.length > 0 && steps < 400) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (seen.has(current as object)) {
      continue;
    }
    seen.add(current as object);

    const record = current as Record<string, unknown>;
    const statusCode =
      toFiniteNumber(record.statusCode)
      ?? toFiniteNumber(record.status)
      ?? toFiniteNumber(record.httpStatus)
      ?? toFiniteNumber((record.error as Record<string, unknown> | undefined)?.status)
      ?? toFiniteNumber((record.error as Record<string, unknown> | undefined)?.statusCode);
    if (statusCode === 429) {
      return true;
    }

    const codeCandidates = [
      toNonEmptyString(record.code),
      toNonEmptyString(record.errorCode),
      toNonEmptyString(record.upstreamCode),
      toNonEmptyString((record.error as Record<string, unknown> | undefined)?.code)
    ];
    if (codeCandidates.some((candidate) => isRateLimitCode(candidate))) {
      return true;
    }

    for (const child of Object.values(record)) {
      if (!child || typeof child !== 'object') {
        continue;
      }
      queue.push(child);
    }
  }

  return false;
}

export function shouldSuppressSnapshotFor429(stage: string, payload: unknown): boolean {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (!normalizedStage) {
    return false;
  }
  if (
    !normalizedStage.includes('provider-error')
    && !normalizedStage.includes('provider-response')
    && !normalizedStage.includes('provider-request.retry')
    && !normalizedStage.includes('provider-response.retry')
  ) {
    return false;
  }
  return read429HintFromSnapshotPayload(payload);
}

export async function purge429ProviderSnapshotArtifacts(options: {
  entryEndpoint?: string;
  requestId: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
}): Promise<void> {
  const { folder } = resolveEndpoint(options.entryEndpoint);
  const base = resolveRccSnapshotsDirFromEnv();
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');

  if (providerToken) {
    const providerDir = path.join(base, folder, providerToken, groupRequestId);
    try {
      await fsp.rm(providerDir, { recursive: true, force: true });
    } catch (error) {
      logSnapshotNonBlockingError(`purge429.providerDir:${providerToken}/${groupRequestId}`, error);
    }
  }

  // Legacy fallback layout: <base>/<folder>/<groupRequestId>/provider-*.json
  const legacyDir = path.join(base, folder, groupRequestId);
  try {
    const entries = await fsp.readdir(legacyDir, { withFileTypes: true });
    const providerFilePattern = /^provider-(request|response|error)(\.retry)?(?:_\d+)?\.json$/;
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && providerFilePattern.test(entry.name))
        .map((entry) => fsp.rm(path.join(legacyDir, entry.name), { force: true }))
    );
  } catch (error) {
    const code = toErrorCode(error);
    if (code !== 'ENOENT') {
      logSnapshotNonBlockingError(`purge429.legacyDir:${groupRequestId}`, error);
    }
  }
}

export function schedule429ProviderSnapshotPurge(options: {
  entryEndpoint?: string;
  requestId: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
}): void {
  const recheckDelaysMs = [250, 1000, 3000];
  for (const delayMs of recheckDelaysMs) {
    const timer = setTimeout(() => {
      void purge429ProviderSnapshotArtifacts(options).catch((error) => {
        logSnapshotNonBlockingError(`purge429.schedule:${options.requestId}:${delayMs}`, error);
      });
    }, delayMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }
}
