import type { ChatMessageContentPart } from '../types/chat-envelope.js';
import type { StandardizedMessage, StandardizedRequest } from '../types/standardized.js';
import {
  setHeartbeatEnabled,
  startHeartbeatDaemonIfNeeded
} from '../../../servertool/heartbeat/task-store.js';
import { findLastUserMessageIndex } from './chat-process-clock-reminder-messages.js';

const HEARTBEAT_ON_MARKER = /<\*\*hb:on\*\*>/gi;
const HEARTBEAT_OFF_MARKER = /<\*\*hb:off\*\*>/gi;

type HeartbeatDirectiveAction = 'on' | 'off';

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

function stripHeartbeatMarkersFromText(raw: string): {
  text: string;
  actions: HeartbeatDirectiveAction[];
} {
  const actions: HeartbeatDirectiveAction[] = [];
  const text = raw
    .replace(HEARTBEAT_ON_MARKER, () => {
      actions.push('on');
      return '';
    })
    .replace(HEARTBEAT_OFF_MARKER, () => {
      actions.push('off');
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, actions };
}

function stripHeartbeatMarkersFromContent(
  content: StandardizedMessage['content']
): {
  content: StandardizedMessage['content'];
  actions: HeartbeatDirectiveAction[];
} {
  if (typeof content === 'string') {
    const stripped = stripHeartbeatMarkersFromText(content);
    return {
      content: stripped.text,
      actions: stripped.actions
    };
  }
  if (!Array.isArray(content)) {
    return { content, actions: [] };
  }
  const actions: HeartbeatDirectiveAction[] = [];
  const nextParts = content.map((part) => {
    if (!part || typeof part !== 'object') {
      return part;
    }
    const typedPart = part as ChatMessageContentPart;
    if (typedPart.type !== 'text' || typeof typedPart.text !== 'string') {
      return part;
    }
    const stripped = stripHeartbeatMarkersFromText(typedPart.text);
    actions.push(...stripped.actions);
    return { ...typedPart, text: stripped.text };
  });
  return { content: nextParts, actions };
}

async function persistHeartbeatDirective(
  tmuxSessionId: string | undefined,
  action: HeartbeatDirectiveAction | undefined
): Promise<void> {
  if (!tmuxSessionId || !action) {
    return;
  }
  await setHeartbeatEnabled(tmuxSessionId, action === 'on');
  if (action === 'on') {
    try {
      await startHeartbeatDaemonIfNeeded(undefined);
    } catch {
      // best-effort only
    }
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

  const stripped = stripHeartbeatMarkersFromContent(targetMessage.content);
  if (stripped.actions.length < 1) {
    return request;
  }

  const nextMessages = messages.slice();
  nextMessages[lastUserIndex] = {
    ...targetMessage,
    content: stripped.content
  };

  const lastAction = stripped.actions[stripped.actions.length - 1];
  const tmuxSessionId = readTmuxSessionId(
    metadata,
    request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
      ? (request.metadata as Record<string, unknown>)
      : null
  );
  await persistHeartbeatDirective(tmuxSessionId, lastAction);

  return {
    ...request,
    messages: nextMessages
  };
}
