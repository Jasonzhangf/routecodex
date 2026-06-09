import { normalizeClientInjectTextWithNative } from '../../native/router-hotpath/native-servertool-core-semantics.js';

export function sanitizeFollowupText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return '';
  }
  return normalizeClientInjectTextWithNative(text);
}

export function sanitizeFollowupSnapshotText(raw: unknown): string {
  return sanitizeFollowupText(raw);
}
