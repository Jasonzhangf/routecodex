import type { StandardizedRequest } from '../types/standardized.js';
import {
  setHeartbeatEnabled,
  startHeartbeatDaemonIfNeeded
} from '../../../servertool/heartbeat/task-store.js';
import { findLastUserMessageIndex } from './chat-process-clock-reminder-messages.js';
import { stripMarkerSyntaxFromContent } from '../../shared/marker-lifecycle.js';

type HeartbeatDirective =
  | { action: 'on' }
  | { action: 'off' }
  | { action: 'on'; intervalMs: number };

function logHeartbeatDirectiveNonBlockingError(
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const detailPairs = Object.entries(details || {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  const suffix = detailPairs ? ` ${suffixSanitize(detailPairs)}` : '';
  console.warn(`[heartbeat-directives] ${operation} failed (non-blocking): ${reason}${suffix}`);
}

function suffixSanitize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readTmuxSessionId(
  primary?: Record<string, unknown> | null,
  fallback?: Record<string, unknown> | null
): string | undefined {
  const candidates = [
    primary?.tmuxSessionId,
    primary?.clientTmuxSessionId,
    fallback?.tmuxSessionId,
    fallback?.clientTmuxSessionId,
    primary?.stopMessageClientInjectSessionScope,
    fallback?.stopMessageClientInjectSessionScope
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('tmux:')) {
      return trimmed.slice('tmux:'.length).trim() || undefined;
    }
    return trimmed;
  }
  return undefined;
}

function parseHeartbeatDirectiveBody(raw: string): HeartbeatDirective | undefined {
  const body = String(raw || '').trim().toLowerCase();
  if (!body) {
    return undefined;
  }
  if (body === 'on') {
    return { action: 'on' };
  }
  if (body === 'off') {
    return { action: 'off' };
  }
  const intervalMatch = body.match(/^(\d+)\s*([smhd])$/i);
  if (!intervalMatch) {
    return undefined;
  }
  const amount = Number.parseInt(String(intervalMatch[1] || '').trim(), 10);
  const unit = String(intervalMatch[2] || '').trim().toLowerCase();
  const multiplier = unit === 's'
    ? 1_000
    : unit === 'm'
      ? 60_000
      : unit === 'h'
        ? 60 * 60_000
        : unit === 'd'
          ? 24 * 60 * 60_000
          : 0;
  if (!Number.isFinite(amount) || amount < 1 || multiplier < 1) {
    return undefined;
  }
  return { action: 'on', intervalMs: amount * multiplier };
}

async function persistHeartbeatDirective(
  tmuxSessionId: string | undefined,
  directive: HeartbeatDirective | undefined
): Promise<void> {
  if (!tmuxSessionId || !directive) {
    return;
  }
  const intervalMs = 'intervalMs' in directive ? directive.intervalMs : undefined;
  try {
    if (directive.action === 'off') {
      await setHeartbeatEnabled(tmuxSessionId, false, { clearIntervalOverride: true });
      return;
    }
    await setHeartbeatEnabled(
      tmuxSessionId,
      true,
      typeof intervalMs === 'number'
        ? { intervalMs }
        : { clearIntervalOverride: true }
    );
    try {
      await startHeartbeatDaemonIfNeeded(undefined);
    } catch (error) {
      logHeartbeatDirectiveNonBlockingError('startHeartbeatDaemonIfNeeded', error, {
        tmuxSessionId,
        action: directive.action,
        ...(typeof intervalMs === 'number' ? { intervalMs } : {})
      });
    }
  } catch (error) {
    logHeartbeatDirectiveNonBlockingError('setHeartbeatEnabled', error, {
      tmuxSessionId,
      action: directive.action,
      ...(typeof intervalMs === 'number' ? { intervalMs } : {})
    });
  }
}

export async function applyHeartbeatDirectives(
  request: StandardizedRequest,
  metadata: Record<string, unknown>
): Promise<StandardizedRequest> {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) {
    return request;
  }

  const targetMessage = messages[lastUserIndex];
  if (!targetMessage || targetMessage.role !== 'user') {
    return request;
  }

  const stripped = stripMarkerSyntaxFromContent<HeartbeatDirective>(targetMessage.content, {
    parse: (body) => {
      const normalized = String(body || '').trim();
      if (!/^hb:/i.test(normalized)) {
        return undefined;
      }
      return parseHeartbeatDirectiveBody(normalized.slice(3));
    }
  });
  const directives = stripped.markers
    .map((marker) => marker.parsed)
    .filter((directive): directive is HeartbeatDirective => Boolean(directive));
  if (directives.length < 1 && stripped.content === targetMessage.content) {
    return request;
  }

  const nextMessages = messages.slice();
  nextMessages[lastUserIndex] = {
    ...targetMessage,
    content: stripped.content
  };

  const lastDirective = directives[directives.length - 1];
  const tmuxSessionId = readTmuxSessionId(
    metadata,
    request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
      ? (request.metadata as Record<string, unknown>)
      : null
  );
  await persistHeartbeatDirective(tmuxSessionId, lastDirective);

  return {
    ...request,
    messages: nextMessages
  };
}
