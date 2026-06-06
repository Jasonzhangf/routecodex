import type { JsonObject } from '../../conversion/hub/types/json.js';
import { containsImageAttachment } from '../../conversion/hub/process/chat-process-media.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { extractCapturedChatSeed } from '../followup-seed.js';

const VIDEO_URL_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;

export function shouldRunVisionFlowForAdapterContext(adapterContext: unknown): boolean {
  const record = adapterContext as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  if (hasInlineMultimodalSupport(record, rt)) {
    return false;
  }
  const routeId = typeof (adapterContext as { routeId?: unknown }).routeId === 'string' ? String((adapterContext as { routeId?: unknown }).routeId).trim().toLowerCase() : '';
  const routeHintFromRt = typeof (rt as any)?.routeHint === 'string' ? String((rt as any).routeHint).trim().toLowerCase() : '';
  const routeHintFromRecord = typeof (record as any).routeHint === 'string' ? String((record as any).routeHint).trim().toLowerCase() : '';
  const routeNameFromRt = typeof (rt as any)?.routeName === 'string' ? String((rt as any).routeName).trim().toLowerCase() : '';
  const resolvedRoute = routeId || routeHintFromRt || routeHintFromRecord || routeNameFromRt;
  if (resolvedRoute === 'multimodal') {
    return false;
  }
  const followupRaw = (rt as any)?.serverToolFollowup;
  const followupFlag = followupRaw === true || followupRaw === 'true';
  if (followupFlag) {
    return false;
  }
  const captured = getCapturedRequest(adapterContext);
  if (isImageGenerationRequest(record, rt, captured)) {
    return false;
  }
  const seed = captured ? extractCapturedChatSeed(captured) : null;
  const hasImageAttachment = Boolean(seed && Array.isArray(seed.messages) && containsImageAttachment(seed.messages as any));
  if (!hasImageAttachment) {
    return false;
  }
  const hasVideoAttachment = latestUserTurnContainsVideo(seed && Array.isArray(seed.messages) ? (seed.messages as unknown[]) : []) || record.hasVideoAttachment === true || (rt as any)?.hasVideoAttachment === true;
  if (hasVideoAttachment) {
    return false;
  }
  const forceVision = record.forceVision === true || record.forceVision === 'true';
  if (forceVision) {
    return true;
  }
  if (resolveInlineMultimodalSupport(record, rt)) {
    return false;
  }
  return true;
}

export function shouldBypassStopMessageForMediaContext(adapterContext: unknown): boolean {
  const captured = getCapturedRequest(adapterContext);
  if (!captured) {
    return false;
  }
  const seed = extractCapturedChatSeed(captured);
  if (!seed || !Array.isArray(seed.messages)) {
    return false;
  }
  return (
    containsImageAttachment(seed.messages as any) ||
    latestUserTurnContainsVideo(seed.messages as unknown[])
  );
}

function resolveInlineMultimodalSupport(record: Record<string, unknown>, rt: Record<string, unknown> | undefined): boolean {
  const protocol = typeof record.providerProtocol === 'string' ? record.providerProtocol.toLowerCase() : '';
  if (protocol === 'gemini-chat' || protocol === 'gemini') {
    return true;
  }
  const providerType = typeof record.providerType === 'string' ? record.providerType.toLowerCase() : '';
  if (providerType === 'gemini') {
    return true;
  }
  const multimodalProvider = typeof (rt as any)?.multimodalProvider === 'string' ? String((rt as any).multimodalProvider).toLowerCase() : '';
  return multimodalProvider === 'native';
}

function hasInlineMultimodalSupport(record: Record<string, unknown>, rt: Record<string, unknown> | undefined): boolean {
  if (record.supportsMultimodal === true || record.supportsMultimodal === 'true') {
    return true;
  }
  if (record.target && typeof record.target === 'object' && !Array.isArray(record.target)) {
    const target = record.target as Record<string, unknown>;
    if (target.supportsMultimodal === true || target.supportsMultimodal === 'true') {
      return true;
    }
  }
  if (rt?.supportsMultimodal === true || rt?.supportsMultimodal === 'true') {
    return true;
  }
  return resolveInlineMultimodalSupport(record, rt);
}

function isImageGenerationRequest(record: Record<string, unknown>, rt: Record<string, unknown> | undefined, captured: unknown): boolean {
  if (hasImageGenerationFlag(record)) {
    return true;
  }
  if (rt && hasImageGenerationFlag(rt)) {
    return true;
  }
  if (!captured || typeof captured !== 'object') {
    return false;
  }
  return hasImageGenerationFlag(captured as Record<string, unknown>);
}

function hasImageGenerationFlag(node: Record<string, unknown>): boolean {
  const tool = typeof node.tool === 'string' ? node.tool.trim().toLowerCase() : '';
  if (tool === 'image_generation' || tool === 'text-to-image') {
    return true;
  }
  const rawFlag = node.isImageGeneration;
  return rawFlag === true || rawFlag === 'true' || rawFlag === '1';
}

function readMediaUrlCandidate(record: Record<string, unknown>, key: 'image_url' | 'video_url'): string {
  const raw = record[key];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const url = (raw as Record<string, unknown>).url;
    return typeof url === 'string' ? url.trim() : '';
  }
  return '';
}

function latestUserTurnContainsVideo(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const role = (msg as { role?: unknown }).role;
    if (typeof role !== 'string' || role.trim().toLowerCase() !== 'user') continue;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
        const type = (part as { type?: unknown }).type;
        if (typeof type === 'string' && type.trim().toLowerCase().includes('video')) return true;
        const imageUrl = readMediaUrlCandidate(part as Record<string, unknown>, 'image_url');
        if (imageUrl && VIDEO_URL_HINT_RE.test(imageUrl)) return true;
        const videoUrl = readMediaUrlCandidate(part as Record<string, unknown>, 'video_url');
        if (videoUrl && VIDEO_URL_HINT_RE.test(videoUrl)) return true;
      }
    }
    return false;
  }
  return false;
}

function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') return null;
  const captured = (adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null;
  return captured as JsonObject;
}
