import type { ChatEnvelope } from '../../types/chat-envelope.js';
import {
  appendDroppedFieldAudit as appendDroppedFieldAuditShared,
  appendLossyFieldAudit as appendLossyFieldAuditShared,
  appendPreservedFieldAudit as appendPreservedFieldAuditShared,
  appendUnsupportedFieldAudit as appendUnsupportedFieldAuditShared,
} from './protocol-mapping-audit.js';

export function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendDroppedFieldAuditShared(chat, options);
}

export function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendLossyFieldAuditShared(chat, options);
}

export function appendPreservedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendPreservedFieldAuditShared(chat, options);
}

export function appendUnsupportedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol?: string;
  reason: string;
}): void {
  appendUnsupportedFieldAuditShared(chat, options);
}
