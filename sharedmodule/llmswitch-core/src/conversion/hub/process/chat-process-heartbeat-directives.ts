import fs from 'node:fs/promises';
import path from 'node:path';

import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';
import {
  setHeartbeatEnabled,
  startHeartbeatDaemonIfNeeded
} from '../../../servertool/heartbeat/task-store.js';
import { findLastUserMessageIndex } from './chat-process-clock-reminder-messages.js';
import {
  stripMarkerSyntaxFromText,
  type MarkerSyntaxMatch
} from '../../shared/marker-lifecycle.js';

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
    primary?.tmux_session_id,
    primary?.client_tmux_session_id,
    fallback?.tmuxSessionId,
    fallback?.clientTmuxSessionId,
    fallback?.tmux_session_id,
    fallback?.client_tmux_session_id,
    primary?.stopMessageClientInjectSessionScope,
    primary?.stop_message_client_inject_session_scope,
    fallback?.stopMessageClientInjectSessionScope,
    fallback?.stop_message_client_inject_session_scope
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

function readWorkdirFromRecord(record?: Record<string, unknown> | null): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const directCandidates = [
    record.workdir,
    record.cwd,
    record.workingDirectory,
    record.clientWorkdir
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  const rt = (record as { __rt?: unknown }).__rt;
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
    return undefined;
  }
  const rtRecord = rt as Record<string, unknown>;
  const rtCandidates = [
    rtRecord.workdir,
    rtRecord.cwd,
    rtRecord.workingDirectory,
    rtRecord.clientWorkdir
  ];
  for (const candidate of rtCandidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function stripHeartbeatStopMarkerFromText(raw: string): { updated: string; changed: boolean } {
  const lines = String(raw || '').split(/\r?\n/);
  let changed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*Heartbeat-Stop-When:\s*.+$/i.test(line)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  return { updated: kept.join('\n'), changed };
}

async function clearHeartbeatStopMarkerForReactivation(workdir: string | undefined): Promise<void> {
  if (!workdir) {
    return;
  }
  const heartbeatPath = path.join(workdir, 'HEARTBEAT.md');
  let raw = '';
  try {
    raw = await fs.readFile(heartbeatPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const stripped = stripHeartbeatStopMarkerFromText(raw);
  if (!stripped.changed) {
    return;
  }
  await fs.writeFile(heartbeatPath, stripped.updated, 'utf8');
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
  directive: HeartbeatDirective | undefined,
  workdir: string | undefined
): Promise<void> {
  if (!tmuxSessionId || !directive) {
    return;
  }
  const intervalMs = 'intervalMs' in directive ? directive.intervalMs : undefined;
  try {
    if (directive.action === 'off') {
      await setHeartbeatEnabled(tmuxSessionId, false, {
        clearIntervalOverride: true,
        source: 'directive',
        reason: 'disabled_by_directive'
      });
      return;
    }
    await setHeartbeatEnabled(
      tmuxSessionId,
      true,
      typeof intervalMs === 'number'
        ? { intervalMs, source: 'directive' }
        : { clearIntervalOverride: true, source: 'directive' }
    );
    try {
      await clearHeartbeatStopMarkerForReactivation(workdir);
    } catch (error) {
      logHeartbeatDirectiveNonBlockingError('clearHeartbeatStopMarkerForReactivation', error, {
        tmuxSessionId,
        workdir: workdir || 'n/a'
      });
    }
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

function stripHeartbeatDirectivesFromContent(
  content: StandardizedMessage['content']
): { content: StandardizedMessage['content']; markers: MarkerSyntaxMatch<HeartbeatDirective>[] } {
  const stripText = (text: string): { text: string; markers: MarkerSyntaxMatch<HeartbeatDirective>[] } => {
    const stripped = stripMarkerSyntaxFromText<HeartbeatDirective>(text, {
      parse: (body) => {
        const normalized = String(body || '').trim();
        if (!/^hb:/i.test(normalized)) {
          return undefined;
        }
        return parseHeartbeatDirectiveBody(normalized.slice(3));
      }
    });
    const parsedMarkers = stripped.markers.filter(
      (marker): marker is MarkerSyntaxMatch<HeartbeatDirective> => Boolean(marker.parsed)
    );
    if (parsedMarkers.length < 1) {
      return { text, markers: [] };
    }
    let next = '';
    let cursor = 0;
    for (const marker of stripped.markers) {
      next += text.slice(cursor, marker.start);
      if (!marker.parsed) {
        next += marker.raw;
      }
      cursor = marker.end;
    }
    next += text.slice(cursor);
    return { text: next.replace(/\n{3,}/g, '\n\n').trim(), markers: parsedMarkers };
  };

  if (typeof content === 'string') {
    const stripped = stripText(content);
    return { content: stripped.text, markers: stripped.markers };
  }

  if (!Array.isArray(content)) {
    return { content, markers: [] };
  }

  const markers: MarkerSyntaxMatch<HeartbeatDirective>[] = [];
  let changed = false;
  const next = content.map((part) => {
    if (typeof part === 'string') {
      const stripped = stripText(part);
      if (stripped.markers.length > 0) {
        changed = true;
        markers.push(...stripped.markers);
        return stripped.text;
      }
      return part;
    }
    if (!part || typeof part !== 'object') {
      return part;
    }
    const record = { ...(part as Record<string, unknown>) };
    let partChanged = false;
    for (const key of ['text', 'content'] as const) {
      if (typeof record[key] !== 'string') {
        continue;
      }
      const stripped = stripText(record[key] as string);
      if (stripped.markers.length > 0) {
        record[key] = stripped.text;
        markers.push(...stripped.markers);
        partChanged = true;
      }
    }
    if (partChanged) {
      changed = true;
      return record as typeof part;
    }
    return part;
  });

  return {
    content: changed ? (next as unknown as StandardizedMessage['content']) : content,
    markers
  };
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

  const stripped = stripHeartbeatDirectivesFromContent(targetMessage.content);
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
  const workdir = readWorkdirFromRecord(metadata)
    || readWorkdirFromRecord(
      request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
        ? (request.metadata as Record<string, unknown>)
        : null
    );
  await persistHeartbeatDirective(tmuxSessionId, lastDirective, workdir);

  return {
    ...request,
    messages: nextMessages
  };
}
