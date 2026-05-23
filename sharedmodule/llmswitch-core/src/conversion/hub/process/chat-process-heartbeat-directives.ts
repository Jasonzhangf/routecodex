import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';
import {
  applyHeartbeatDirectiveRuntimeSideEffects,
  readTmuxSessionId,
  readWorkdirFromRecord
} from './blocks/chat-process-heartbeat-runtime-side-effects.js';
import { findLastUserMessageIndex } from './chat-process-clock-reminder-messages.js';
import {
  stripMarkerSyntaxFromText,
  type MarkerSyntaxMatch
} from '../../shared/marker-lifecycle.js';
import { resolveHeartbeatDirectiveWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';

type HeartbeatDirective =
  | { action: 'on' }
  | { action: 'off' }
  | { action: 'on'; intervalMs: number };

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
  const nativeDirective = resolveHeartbeatDirectiveWithNative({
    messages,
    metadata: metadata || {}
  });
  const lastDirective = nativeDirective.action === 'off'
    ? ({ action: 'off' } as HeartbeatDirective)
    : nativeDirective.action === 'on' && typeof nativeDirective.intervalMs === 'number'
      ? ({ action: 'on', intervalMs: nativeDirective.intervalMs } as HeartbeatDirective)
      : nativeDirective.action === 'on'
        ? ({ action: 'on' } as HeartbeatDirective)
        : undefined;
  if (!lastDirective && stripped.content === targetMessage.content) {
    return request;
  }

  const nextMessages = messages.slice();
  nextMessages[lastUserIndex] = {
    ...targetMessage,
    content: stripped.content
  };

  const tmuxSessionId = typeof nativeDirective.tmuxSessionId === 'string' && nativeDirective.tmuxSessionId.trim().length
    ? nativeDirective.tmuxSessionId.trim()
    : readTmuxSessionId(metadata);
  const workdir = typeof nativeDirective.workdir === 'string' && nativeDirective.workdir.trim().length
    ? nativeDirective.workdir.trim()
    : readWorkdirFromRecord(metadata)
    || readWorkdirFromRecord(
      request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
        ? (request.metadata as Record<string, unknown>)
        : null
    );
  await applyHeartbeatDirectiveRuntimeSideEffects(
    lastDirective
      ? {
          action: lastDirective.action,
          intervalMs: 'intervalMs' in lastDirective ? lastDirective.intervalMs : undefined,
          tmuxSessionId,
          workdir,
          contentChanged: stripped.content !== targetMessage.content
        }
      : null
  );

  return {
    ...request,
    messages: nextMessages
  };
}
