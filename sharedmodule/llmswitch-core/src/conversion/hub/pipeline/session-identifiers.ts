import {
  coerceClientHeadersWithNative,
  extractSessionIdentifiersFromMetadataWithNative,
  findHeaderValueWithNative,
  normalizeHeaderKeyWithNative,
  pickHeaderWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-session-identifiers-semantics.js';

export interface SessionIdentifiers {
  sessionId?: string;
  conversationId?: string;
}

export function extractSessionIdentifiersFromMetadata(
  metadata: Record<string, unknown> | undefined
): SessionIdentifiers {
  return extractSessionIdentifiersFromMetadataWithNative(metadata);
}

export function coerceClientHeaders(raw: unknown): Record<string, string> | undefined {
  return coerceClientHeadersWithNative(raw);
}

export function pickHeader(
  headers: Record<string, string>,
  candidates: string[]
): string | undefined {
  return pickHeaderWithNative(headers, candidates);
}

export function findHeaderValue(
  headers: Record<string, string>,
  target: string
): string | undefined {
  return findHeaderValueWithNative(headers, target);
}

export function normalizeHeaderKey(value: string): string {
  return normalizeHeaderKeyWithNative(value);
}
