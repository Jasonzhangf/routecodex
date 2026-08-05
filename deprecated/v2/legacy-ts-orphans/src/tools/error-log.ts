import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import type { RouteErrorPayload } from '../error-handling/route-error-hub.js';

const STATS_DIR = path.join(os.homedir(), '.routecodex', 'stats');
const ERROR_LOG_FILE = path.join(STATS_DIR, 'error.log');

export type ErrorLogKind =
  | 'http-request'
  | 'http-response'
  | 'timeout'
  | 'provider'
  | 'tool'
  | 'pipeline'
  | 'server'
  | 'cli'
  | 'compat'
  | 'other';

export interface ErrorLogEntry {
  kind: ErrorLogKind;
  timestamp: number;
  requestId?: string;
  endpoint?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  model?: string;
  code: string;
  message: string;
  scope?: string;
  source?: string;
  toolName?: string;
  toolCallId?: string;
  toolPhase?: string;
  timeoutMs?: number;
  details?: Record<string, unknown>;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length ? value : undefined;
}

export function mapRouteErrorToLogEntry(
  payload: RouteErrorPayload,
  extras?: {
    kind?: ErrorLogKind;
    toolName?: string;
    toolCallId?: string;
    toolPhase?: string;
    timeoutMs?: number;
  }
): ErrorLogEntry {
  const codeUpper = (payload.code || '').toString().toUpperCase();
  let inferredKind: ErrorLogKind =
    payload.scope === 'http'
      ? 'http-response'
      : payload.scope === 'provider'
        ? 'provider'
        : payload.scope === 'pipeline'
          ? 'pipeline'
          : payload.scope === 'server'
            ? 'server'
          : payload.scope === 'cli'
            ? 'cli'
            : payload.scope === 'compat'
              ? 'compat'
                : 'other';

  if (!extras?.kind) {
    if (codeUpper === 'TIMEOUT_ERROR' || codeUpper === 'HTTP_TIMEOUT') {
      inferredKind = 'timeout';
    } else if (codeUpper === 'TOOL_ERROR') {
      inferredKind = 'tool';
    }
  }

  const kind = extras?.kind ?? inferredKind;

  // 尝试从 details 中提取工具相关字段，方便错误检索。
  const rawDetails: Record<string, unknown> | undefined = payload.details;
  let toolName: string | undefined;
  let toolCallId: string | undefined;
  let toolPhase: string | undefined;
  let timeoutMs: number | undefined;
  if (rawDetails) {
    const inner =
      rawDetails.details && typeof rawDetails.details === 'object'
        ? (rawDetails.details as Record<string, unknown>)
        : rawDetails;
    if (typeof inner.toolName === 'string' && inner.toolName.trim().length) {
      toolName = inner.toolName.trim();
    }
    if (typeof inner.toolCallId === 'string' && inner.toolCallId.trim().length) {
      toolCallId = inner.toolCallId.trim();
    }
    if (typeof inner.toolPhase === 'string' && inner.toolPhase.trim().length) {
      toolPhase = inner.toolPhase.trim();
    }
    const timeoutCandidate = inner.timeoutMs;
    if (typeof timeoutCandidate === 'number' && Number.isFinite(timeoutCandidate) && timeoutCandidate >= 0) {
      timeoutMs = timeoutCandidate;
    }
  }

  const details: Record<string, unknown> = {
    ...(payload.details || {})
  };

  return {
    kind,
    timestamp: payload.timestamp ?? Date.now(),
    requestId: coerceString(payload.requestId),
    endpoint: coerceString(payload.endpoint),
    providerKey: coerceString(payload.providerKey),
    providerType: coerceString(payload.providerType),
    routeName: coerceString(payload.routeName),
    model: coerceString(payload.model),
    code: payload.code,
    message: payload.message,
    scope: payload.scope,
    source: payload.source,
    toolName: extras?.toolName ?? toolName,
    toolCallId: extras?.toolCallId ?? toolCallId,
    toolPhase: extras?.toolPhase ?? toolPhase,
    timeoutMs: extras?.timeoutMs ?? timeoutMs,
    details: Object.keys(details).length ? details : undefined
  };
}

export async function appendErrorLogEntry(entry: ErrorLogEntry): Promise<void> {
  try {
    await fs.mkdir(STATS_DIR, { recursive: true });
    const payload = JSON.stringify(entry);
    await fs.appendFile(ERROR_LOG_FILE, `${payload}\n`, 'utf8');
  } catch {
    // best-effort only; never crash on stats errors
  }
}

export const ERROR_LOG_PATH = ERROR_LOG_FILE;

export async function readErrorLogEntries(limit?: number): Promise<ErrorLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ERROR_LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const entries: ErrorLogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ErrorLogEntry;
      if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') {
        entries.push(parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && entries.length > limit) {
    return entries.slice(-limit);
  }
  return entries;
}
