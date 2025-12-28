import type { UnknownObject } from '../../../types/common-types.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';

const DEBUG_ENV_KEY = 'ROUTECODEX_VISION_DEBUG';

const truthyValues = new Set(['1', 'true', 'yes']);

function visionDebugEnabled(): boolean {
  const raw = process.env[DEBUG_ENV_KEY];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return truthyValues.has(normalized);
}

type DebugFallback = {
  routeName?: string;
  requestId?: string;
};

export function shouldCaptureVisionDebug(
  source?: UnknownObject,
  fallback?: DebugFallback
): { enabled: boolean; routeName?: string; requestId?: string } {
  if (!visionDebugEnabled()) {
    return { enabled: false };
  }
  const metadata = source ? extractProviderRuntimeMetadata(source) : undefined;
  const routeName = (metadata?.routeName ?? fallback?.routeName ?? '').toLowerCase();
  if (routeName !== 'vision') {
    return { enabled: false };
  }
  const requestId = metadata?.requestId ?? fallback?.requestId;
  return {
    enabled: true,
    routeName: metadata?.routeName ?? fallback?.routeName ?? 'vision',
    requestId
  };
}

function safeClone<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

function pickMessages(source?: UnknownObject): unknown[] | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record.messages as unknown[];
  }
  const dataNode = record.data;
  if (dataNode && typeof dataNode === 'object') {
    const messages = (dataNode as Record<string, unknown>).messages;
    if (Array.isArray(messages)) {
      return messages as unknown[];
    }
  }
  return undefined;
}

export function summarizeVisionMessages(source?: UnknownObject): string {
  const messages = pickMessages(source);
  if (!messages || !messages.length) {
    return 'messages=0';
  }
  const tokens: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== 'object') {
      tokens.push(`#${i}:unknown`);
      continue;
    }
    const role = typeof (message as Record<string, unknown>).role === 'string'
      ? ((message as Record<string, unknown>).role as string)
      : `#${i}`;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      tokens.push(`${role}:text`);
      continue;
    }
    if (Array.isArray(content)) {
      const parts = content.map((part) => {
        if (!part || typeof part !== 'object') {
          return typeof part;
        }
        const typeValue = (part as Record<string, unknown>).type;
        return typeof typeValue === 'string' ? typeValue : 'object';
      });
      tokens.push(`${role}:${parts.join('+') || 'array'}`);
      continue;
    }
    if (content && typeof content === 'object') {
      const typeValue = (content as Record<string, unknown>).type;
      const label = typeof typeValue === 'string' ? typeValue : 'object';
      tokens.push(`${role}:${label}`);
      continue;
    }
    if (content === null || content === undefined) {
      tokens.push(`${role}:empty`);
      continue;
    }
    tokens.push(`${role}:${typeof content}`);
  }
  return tokens.join(' | ');
}

export function buildVisionSnapshotPayload(
  payload: UnknownObject,
  extras?: Record<string, unknown>
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    summary: summarizeVisionMessages(payload)
  };
  const cloned = safeClone(payload);
  if (cloned !== undefined) {
    snapshot.payload = cloned;
  } else {
    snapshot.payloadError = 'unserializable';
  }
  if (extras) {
    snapshot.extras = safeClone(extras) ?? extras;
  }
  return snapshot;
}
