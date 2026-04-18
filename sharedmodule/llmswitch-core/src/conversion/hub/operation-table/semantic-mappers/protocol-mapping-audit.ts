import type {
  ChatEnvelope,
  ChatProtocolMappingAuditEntry,
  ChatProtocolMappingDisposition,
  ChatSemanticAudit,
  ChatSemantics
} from '../../types/chat-envelope.js';
import { type JsonValue } from '../../types/json.js';

export const DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV =
  'ROUTECODEX_DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR';

function ensureSemantics(chat: ChatEnvelope): ChatSemantics {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  return chat.semantics;
}

function ensureAuditRoot(chat: ChatEnvelope): NonNullable<ChatSemanticAudit['protocolMapping']> {
  const semantics = ensureSemantics(chat);
  if (!semantics.audit || typeof semantics.audit !== 'object' || Array.isArray(semantics.audit)) {
    semantics.audit = {};
  }
  const audit = semantics.audit as ChatSemanticAudit;
  if (!audit.protocolMapping || typeof audit.protocolMapping !== 'object' || Array.isArray(audit.protocolMapping)) {
    audit.protocolMapping = {};
  }
  return audit.protocolMapping;
}

function ensureLegacyMetadataAuditRoot(chat: ChatEnvelope): Record<string, unknown> {
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : ((chat.metadata = { context: (chat.metadata as any)?.context ?? {} } as any) as unknown as Record<string, unknown>);
  const root =
    metadata.mappingAudit && typeof metadata.mappingAudit === 'object' && !Array.isArray(metadata.mappingAudit)
      ? (metadata.mappingAudit as Record<string, unknown>)
      : ((metadata.mappingAudit = {}) as Record<string, unknown>);
  return root;
}

function readSourceProtocol(chat: ChatEnvelope): string | undefined {
  const context = chat.metadata && typeof chat.metadata === 'object'
    ? ((chat.metadata as Record<string, unknown>).context as Record<string, unknown> | undefined)
    : undefined;
  return typeof context?.providerProtocol === 'string' && context.providerProtocol.trim()
    ? context.providerProtocol.trim()
    : undefined;
}

function readRuntimeEnv(): Record<string, string | undefined> {
  if (typeof process !== 'undefined' && process?.env) {
    return process.env;
  }
  return {};
}

export function shouldMirrorProtocolMappingAuditToLegacy(
  env: Record<string, string | undefined> = readRuntimeEnv()
): boolean {
  const disabled = env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV];
  return disabled !== '1';
}

export function readProtocolMappingAudit(chat: ChatEnvelope): NonNullable<ChatSemanticAudit['protocolMapping']> | undefined {
  const semanticsAudit = chat.semantics?.audit;
  if (semanticsAudit && typeof semanticsAudit === 'object' && !Array.isArray(semanticsAudit)) {
    const protocolMapping = (semanticsAudit as ChatSemanticAudit).protocolMapping;
    if (protocolMapping && typeof protocolMapping === 'object' && !Array.isArray(protocolMapping)) {
      return protocolMapping;
    }
  }
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : undefined;
  const legacy = metadata?.mappingAudit;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    return legacy as NonNullable<ChatSemanticAudit['protocolMapping']>;
  }
  return undefined;
}

export function readLegacyProtocolMappingAudit(
  chat: ChatEnvelope
): NonNullable<ChatSemanticAudit['protocolMapping']> | undefined {
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : undefined;
  const legacy = metadata?.mappingAudit;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    return legacy as NonNullable<ChatSemanticAudit['protocolMapping']>;
  }
  return undefined;
}

export function readProtocolMappingAuditBucket(
  chat: ChatEnvelope,
  bucket: ChatProtocolMappingDisposition
): ChatProtocolMappingAuditEntry[] {
  const root = readProtocolMappingAudit(chat);
  const items = root?.[bucket];
  return Array.isArray(items) ? items : [];
}

export function readLegacyProtocolMappingAuditBucket(
  chat: ChatEnvelope,
  bucket: ChatProtocolMappingDisposition
): ChatProtocolMappingAuditEntry[] {
  const root = readLegacyProtocolMappingAudit(chat);
  const items = root?.[bucket];
  return Array.isArray(items) ? items : [];
}

export function appendProtocolMappingAudit(chat: ChatEnvelope, options: {
  bucket: ChatProtocolMappingDisposition;
  field: string;
  targetProtocol?: string;
  sourceProtocol?: string;
  reason: string;
  source?: string;
}): void {
  const sourceProtocol = options.sourceProtocol ?? readSourceProtocol(chat);
  const entry: ChatProtocolMappingAuditEntry = {
    field: options.field,
    disposition: options.bucket,
    reason: options.reason,
    ...(sourceProtocol ? { sourceProtocol } : {}),
    ...(options.targetProtocol ? { targetProtocol: options.targetProtocol } : {}),
    source: options.source ?? 'chat.parameters'
  };

  const auditRoot = ensureAuditRoot(chat);
  const current = Array.isArray(auditRoot[options.bucket])
    ? ([...(auditRoot[options.bucket] as ChatProtocolMappingAuditEntry[])] as ChatProtocolMappingAuditEntry[])
    : [];
  const duplicate = current.find((candidate) =>
    candidate &&
    candidate.field === entry.field &&
    candidate.targetProtocol === entry.targetProtocol &&
    candidate.reason === entry.reason &&
    candidate.source === entry.source &&
    candidate.sourceProtocol === entry.sourceProtocol
  );
  if (!duplicate) {
    current.push(entry);
  }
  auditRoot[options.bucket] = current;

  if (!shouldMirrorProtocolMappingAuditToLegacy()) {
    return;
  }

  const legacyRoot = ensureLegacyMetadataAuditRoot(chat);
  const legacyCurrent = Array.isArray(legacyRoot[options.bucket])
    ? (legacyRoot[options.bucket] as Array<Record<string, unknown>>)
    : [];
  const legacyDuplicate = legacyCurrent.find((candidate) =>
    candidate &&
    candidate.field === entry.field &&
    candidate.targetProtocol === entry.targetProtocol &&
    candidate.reason === entry.reason &&
    candidate.source === entry.source &&
    candidate.sourceProtocol === entry.sourceProtocol
  );
  if (!legacyDuplicate) {
    legacyCurrent.push(entry as unknown as Record<string, unknown>);
  }
  legacyRoot[options.bucket] = legacyCurrent as unknown as JsonValue;
}

export function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
  sourceProtocol?: string;
}): void {
  appendProtocolMappingAudit(chat, {
    bucket: 'dropped',
    ...options
  });
}

export function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
  sourceProtocol?: string;
}): void {
  appendProtocolMappingAudit(chat, {
    bucket: 'lossy',
    ...options
  });
}

export function appendPreservedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
  sourceProtocol?: string;
}): void {
  appendProtocolMappingAudit(chat, {
    bucket: 'preserved',
    ...options
  });
}

export function appendUnsupportedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol?: string;
  reason: string;
  source?: string;
  sourceProtocol?: string;
}): void {
  appendProtocolMappingAudit(chat, {
    bucket: 'unsupported',
    ...options
  });
}
