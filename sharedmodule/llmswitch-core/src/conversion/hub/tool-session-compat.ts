import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import type { ChatEnvelope, ChatMessage } from './types/chat-envelope.js';
import type { AdapterContext } from './types/chat-envelope.js';
import type { JsonObject } from './types/json.js';
import { extractSessionIdentifiersFromMetadata } from './pipeline/session-identifiers.js';
import {
  normalizeToolSessionMessagesWithNative,
  updateToolSessionHistoryWithNative
} from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  resolveRccPath
} from '../../runtime/user-data-paths.js';

type ToolHistoryStatus = 'ok' | 'error' | 'unknown';

export interface ToolHistoryMessageRecord {
  role: 'user' | 'assistant' | 'tool';
  toolUse?: { id: string; name?: string };
  toolResult?: { id: string; name?: string; status: ToolHistoryStatus };
  ts: string;
}

export interface ToolSessionHistory {
  lastMessages: ToolHistoryMessageRecord[];
  pendingToolUses: Record<string, { name?: string; ts: string }>;
  updatedAt: string;
}

const TOOL_HISTORY_ROOT = resolveRccPath('tool-history');

function sanitizeSessionId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function loadSessionHistory(sessionId: string): Promise<ToolSessionHistory | null> {
  try {
    const fileName = `${sanitizeSessionId(sessionId)}.json`;
    const file = path.join(TOOL_HISTORY_ROOT, fileName);
    if (!fsSync.existsSync(file)) {
      return null;
    }
    const text = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(text) as ToolSessionHistory;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    parsed.lastMessages = Array.isArray(parsed.lastMessages) ? parsed.lastMessages : [];
    parsed.pendingToolUses = parsed.pendingToolUses && typeof parsed.pendingToolUses === 'object'
      ? (parsed.pendingToolUses as Record<string, { name?: string; ts: string }>)
      : {};
    parsed.updatedAt = typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length
      ? parsed.updatedAt
      : new Date().toISOString();
    return parsed;
  } catch {
    return null;
  }
}

async function persistSessionHistory(sessionId: string, history: ToolSessionHistory): Promise<void> {
  try {
    if (!fsSync.existsSync(TOOL_HISTORY_ROOT)) {
      await fs.mkdir(TOOL_HISTORY_ROOT, { recursive: true });
    }
    const file = path.join(TOOL_HISTORY_ROOT, `${sanitizeSessionId(sessionId)}.json`);
    const payload = JSON.stringify(history);
    await fs.writeFile(file, payload, 'utf-8');
  } catch {
    // history persistence must never block the main flow
  }
}

export async function applyToolSessionCompat(chat: ChatEnvelope, ctx: AdapterContext): Promise<void> {
  if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
    return;
  }

  const normalized = normalizeToolSessionMessagesWithNative({
    messages: chat.messages as unknown[],
    ...(Array.isArray(chat.toolOutputs) && chat.toolOutputs.length
      ? { toolOutputs: chat.toolOutputs as unknown[] }
      : {})
  });
  chat.messages = normalized.messages as ChatMessage[];
  chat.toolOutputs = Array.isArray(normalized.toolOutputs) && normalized.toolOutputs.length
    ? (normalized.toolOutputs as typeof chat.toolOutputs)
    : undefined;

  const entry = (ctx.entryEndpoint || '').toLowerCase();
  if (!entry.includes('/v1/messages')) {
    return;
  }

  const metadata = (chat.metadata || {}) as JsonObject;
  const identifiers = extractSessionIdentifiersFromMetadata(metadata as Record<string, unknown> | undefined);
  const sessionId = identifiers.sessionId;
  if (!sessionId) {
    return;
  }

  const history = await loadSessionHistory(sessionId);
  const updated = updateToolSessionHistoryWithNative({
    messages: chat.messages as unknown[],
    ...(history ? { existingHistory: history } : {})
  });
  if (!updated.history) {
    return;
  }
  await persistSessionHistory(sessionId, updated.history as unknown as ToolSessionHistory);
}
