import type { StandardizedMessage } from '../../conversion/hub/types/standardized.js';
import { isIP } from 'node:net';

export function getLatestUserMessage(messages: StandardizedMessage[]): StandardizedMessage | undefined {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    if (messages[idx]?.role === 'user') {
      return messages[idx];
    }
  }
  return undefined;
}

export function getLatestMessageRole(messages: StandardizedMessage[]): string | undefined {
  if (!Array.isArray(messages) || !messages.length) {
    return undefined;
  }
  const last = messages[messages.length - 1];
  if (last && typeof last.role === 'string' && last.role.trim()) {
    return last.role.trim();
  }
  return undefined;
}

export function extractMessageText(message: StandardizedMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (typeof entry === 'string' && entry.trim()) {
        parts.push(entry);
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as { text?: unknown; content?: unknown };
        if (typeof record.text === 'string' && record.text.trim()) {
          parts.push(record.text);
        } else if (typeof record.content === 'string' && record.content.trim()) {
          parts.push(record.content);
        }
      }
    }
    const joined = parts.join('\n').trim();
    if (joined) {
      return joined;
    }
  }
  return '';
}

export function detectKeyword(text: string, keywords: string[]): boolean {
  if (!text) return false;
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

export function detectExtendedThinkingKeyword(text: string): boolean {
  if (!text) {
    return false;
  }
  const keywords = ['仔细分析', '思考', '超级思考', '深度思考', 'careful analysis', 'deep thinking', 'deliberate'];
  return keywords.some((keyword) => text.includes(keyword));
}

export interface MediaAttachmentSignals {
  hasAnyMedia: boolean;
  hasImage: boolean;
  hasVideo: boolean;
  hasRemoteVideo: boolean;
  hasLocalVideo: boolean;
}

const LOCAL_URL_SCHEMES = ['data:', 'file:', 'blob:'] as const;

function extractMediaUrlCandidate(record: Record<string, unknown>): string {
  if (typeof (record as { image_url?: unknown }).image_url === 'string') {
    return (record as { image_url?: string }).image_url ?? '';
  }
  if (typeof (record as { video_url?: unknown }).video_url === 'string') {
    return (record as { video_url?: string }).video_url ?? '';
  }
  if (
    (record as { image_url?: unknown }).image_url &&
    typeof (record as { image_url?: Record<string, unknown> }).image_url?.url === 'string'
  ) {
    return (record as { image_url?: { url?: string } }).image_url?.url ?? '';
  }
  if (
    (record as { video_url?: unknown }).video_url &&
    typeof (record as { video_url?: Record<string, unknown> }).video_url?.url === 'string'
  ) {
    return (record as { video_url?: { url?: string } }).video_url?.url ?? '';
  }
  if (typeof (record as { url?: unknown }).url === 'string') {
    return (record as { url?: string }).url ?? '';
  }
  if (typeof (record as { uri?: unknown }).uri === 'string') {
    return (record as { uri?: string }).uri ?? '';
  }
  if (typeof (record as { data?: unknown }).data === 'string') {
    return (record as { data?: string }).data ?? '';
  }
  return '';
}

function resolveMediaKind(typeValue: string, record: Record<string, unknown>): 'image' | 'video' | null {
  if (typeValue.includes('video')) {
    return 'video';
  }
  if (typeValue.includes('image')) {
    return 'image';
  }
  if (Object.prototype.hasOwnProperty.call(record, 'video_url')) {
    return 'video';
  }
  if (Object.prototype.hasOwnProperty.call(record, 'image_url')) {
    return 'image';
  }
  return null;
}

function isPrivateHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === 'localhost' || normalized.endsWith('.local')) {
    return true;
  }
  const ipType = isIP(normalized);
  if (ipType === 4) {
    const octets = normalized.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((value) => !Number.isFinite(value))) {
      return true;
    }
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 0) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    return false;
  }
  if (ipType === 6) {
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

function isRemotePublicHttpUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) {
    return false;
  }
  const lowered = value.toLowerCase();
  if (LOCAL_URL_SCHEMES.some((prefix) => lowered.startsWith(prefix))) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return !isPrivateHost(parsed.hostname);
}

export function analyzeMediaAttachments(message: StandardizedMessage | undefined): MediaAttachmentSignals {
  const result: MediaAttachmentSignals = {
    hasAnyMedia: false,
    hasImage: false,
    hasVideo: false,
    hasRemoteVideo: false,
    hasLocalVideo: false
  };
  if (!message) {
    return result;
  }

  if (typeof message.content === 'string' && message.content.trim()) {
    const raw = message.content;
    const hasImageBlock = /"type"\s*:\s*"(?:input_)?image(?:_url)?"/iu.test(raw);
    const hasVideoBlock = /"type"\s*:\s*"(?:input_)?video(?:_url)?"/iu.test(raw);
    const hasDataVideo = /data:video\//iu.test(raw);
    const hasRemoteVideo = /https?:\/\/[^\s"'\\]+/iu.test(raw);
    if (hasImageBlock || hasVideoBlock) {
      result.hasAnyMedia = true;
    }
    if (hasImageBlock) {
      result.hasImage = true;
    }
    if (hasVideoBlock) {
      result.hasVideo = true;
      if (hasDataVideo) {
        result.hasLocalVideo = true;
      }
      if (hasRemoteVideo) {
        result.hasRemoteVideo = true;
      }
      if (!hasDataVideo && !hasRemoteVideo) {
        result.hasLocalVideo = true;
      }
    }
    if (result.hasAnyMedia) {
      return result;
    }
  }

  if (!Array.isArray(message.content)) {
    return result;
  }

  for (const part of message.content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const record = part as Record<string, unknown>;
    const typeValue = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const mediaKind = resolveMediaKind(typeValue, record);
    if (!mediaKind) {
      continue;
    }
    const mediaUrl = extractMediaUrlCandidate(record).trim();
    if (!mediaUrl) {
      continue;
    }
    result.hasAnyMedia = true;
    if (mediaKind === 'image') {
      result.hasImage = true;
      continue;
    }
    result.hasVideo = true;
    if (isRemotePublicHttpUrl(mediaUrl)) {
      result.hasRemoteVideo = true;
    } else {
      result.hasLocalVideo = true;
    }
  }

  return result;
}

export function detectImageAttachment(message: StandardizedMessage | undefined): boolean {
  return analyzeMediaAttachments(message).hasAnyMedia;
}
