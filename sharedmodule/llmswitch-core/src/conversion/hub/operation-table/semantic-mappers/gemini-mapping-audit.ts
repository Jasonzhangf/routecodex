import type { ChatEnvelope } from '../../types/chat-envelope.js';
import { type JsonValue } from '../../types/json.js';

function appendMappingAudit(chat: ChatEnvelope, options: {
  bucket: 'dropped' | 'lossy';
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
}): void {
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : ((chat.metadata = { context: (chat.metadata as any)?.context ?? {} } as any) as unknown as Record<string, unknown>);
  const root =
    metadata.mappingAudit && typeof metadata.mappingAudit === 'object' && !Array.isArray(metadata.mappingAudit)
      ? (metadata.mappingAudit as Record<string, unknown>)
      : ((metadata.mappingAudit = {}) as Record<string, unknown>);
  const current = Array.isArray(root[options.bucket]) ? (root[options.bucket] as Array<Record<string, unknown>>) : [];
  const duplicate = current.find((entry) =>
    entry &&
    entry.field === options.field &&
    entry.targetProtocol === options.targetProtocol &&
    entry.reason === options.reason
  );
  if (!duplicate) {
    current.push({
      field: options.field,
      source: options.source ?? 'chat.parameters',
      targetProtocol: options.targetProtocol,
      reason: options.reason
    });
  }
  root[options.bucket] = current as unknown as JsonValue;
}

export function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'dropped',
    ...options
  });
}

export function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'lossy',
    ...options
  });
}
