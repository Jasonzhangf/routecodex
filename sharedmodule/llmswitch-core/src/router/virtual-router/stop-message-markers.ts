import type { ProcessedRequest, StandardizedMessage, StandardizedRequest } from '../../conversion/hub/types/standardized.js';
import type { RouterMetadataInput, StopMessageStateSnapshot } from './types.js';
import { parseRoutingInstructionKindsWithNative } from './engine-selection/native-virtual-router-routing-instructions-semantics.js';
import { parseStopMessageInstructionWithNative } from './engine-selection/native-virtual-router-stop-message-semantics.js';
import { extractMessageText, getLatestUserMessage } from './message-utils.js';
import { resolveStopMessageScope } from './engine/routing-state/store.js';
import { isStopMessageFileReference, resolveStopMessageText } from './stop-message-file-resolver.js';
import type { RoutingInstruction } from './routing-instructions.js';
import {
  cleanMarkerSyntaxInPlace,
  hasMarkerSyntax,
} from '../../conversion/shared/marker-lifecycle.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;
const STOP_MESSAGE_INSTRUCTION_TYPES = new Set(['stopMessageSet', 'stopMessageMode', 'stopMessageClear']);
const STOP_MESSAGE_SCOPED_TYPES = new Set(['stopMessageSet', 'stopMessageMode', 'stopMessageClear', 'preCommandSet', 'preCommandClear']);
const STOP_MESSAGE_KEYWORD_PATTERN = /stopmessage/i;

export type StopMessageMarkerParseLog = {
  requestId: string;
  markerDetected: boolean;
  preview: string;
  stopMessageTypes: string[];
  scopedTypes: string[];
  stopScope?: string;
};

export function parseStopMessageInstruction(
  instruction: string
): RoutingInstruction | null {
  const resolved = parseStopMessageInstructionWithNative(instruction);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === 'clear') {
    return { type: 'stopMessageClear' };
  }
  return {
    type: 'stopMessageSet',
    stopMessageText: resolveStopMessageText(resolved.text),
    stopMessageMaxRepeats: resolved.maxRepeats,
    stopMessageSource: isStopMessageFileReference(resolved.text) ? 'explicit_file' : 'explicit_text',
    ...(resolved.aiMode ? { stopMessageAiMode: resolved.aiMode } : {})
  };
}

export function buildStopMessageMarkerParseLog(
  request: StandardizedRequest | ProcessedRequest,
  metadata: RouterMetadataInput
): StopMessageMarkerParseLog | null {
  const messages = Array.isArray((request as { messages?: unknown }).messages)
    ? (((request as { messages?: unknown[] }).messages ?? []) as StandardizedMessage[])
    : [];
  if (!messages.length) {
    return null;
  }
  const latest = getLatestUserMessage(messages);
  const latestText = latest ? extractMessageText(latest).trim() : '';
  const latestHasMarker = hasMarkerSyntax(latestText);
  const hasStopKeyword = STOP_MESSAGE_KEYWORD_PATTERN.test(latestText);
  if (!hasStopKeyword && !latestHasMarker) {
    return null;
  }
  const parsedKinds = parseRoutingInstructionKindsWithNative(request as unknown as Record<string, unknown>);
  const stopMessageTypes = parsedKinds.filter((type) => STOP_MESSAGE_INSTRUCTION_TYPES.has(type));
  const scopedTypes = parsedKinds.filter((type) => STOP_MESSAGE_SCOPED_TYPES.has(type));
  if (!hasStopKeyword && stopMessageTypes.length === 0 && scopedTypes.length === 0) {
    return null;
  }
  return {
    requestId: metadata.requestId || 'n/a',
    markerDetected: latestHasMarker,
    preview: latestText.replace(/\s+/g, ' ').slice(0, 120),
    stopMessageTypes,
    scopedTypes,
    stopScope: resolveStopMessageScope(metadata)
  };
}

export function emitStopMessageMarkerParseLog(log: StopMessageMarkerParseLog | null): void {
  if (!log) {
    return;
  }
  const reset = '\x1b[0m';
  const tagColor = '\x1b[38;5;39m';
  const scopeColor = '\x1b[38;5;220m';
  console.log(
    `${tagColor}[virtual-router][stop_message_parse]${reset} requestId=${log.requestId} marker=${log.markerDetected ? 'detected' : 'missing'} parsed=${log.stopMessageTypes.join(',') || 'none'} preview=${log.preview}`
  );
  if (log.scopedTypes.length > 0) {
    if (log.stopScope) {
      console.log(
        `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=apply scope=${log.stopScope} instructions=${log.scopedTypes.join(',')}`
      );
    } else {
      console.log(
        `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=drop reason=missing_tmux_scope instructions=${log.scopedTypes.join(',')}`
      );
    }
  }
}

export function cleanStopMessageMarkersInPlace(request: Record<string, unknown>): void {
  cleanMarkerSyntaxInPlace(request);
}

export function formatStopMessageStatusLabel(
  snapshot: StopMessageStateSnapshot | null,
  scope: string | undefined,
  forceShow: boolean
): string {
  const scopeLabel = scope && scope.trim() ? scope.trim() : 'none';

  if (!snapshot) {
    if (!forceShow) {
      return '';
    }
    return `[stopMessage:scope=${scopeLabel} active=no state=cleared]`;
  }

  const text = typeof snapshot.stopMessageText === 'string' ? snapshot.stopMessageText.trim() : '';
  const safeText = text ? (text.length > 24 ? `${text.slice(0, 21)}...` : text) : '(mode-only)';
  const mode = (snapshot.stopMessageStageMode || 'unset').toString().toLowerCase();
  const maxRepeats =
    typeof snapshot.stopMessageMaxRepeats === 'number' && Number.isFinite(snapshot.stopMessageMaxRepeats)
      ? Math.max(0, Math.floor(snapshot.stopMessageMaxRepeats))
      : 0;
  const used =
    typeof snapshot.stopMessageUsed === 'number' && Number.isFinite(snapshot.stopMessageUsed)
      ? Math.max(0, Math.floor(snapshot.stopMessageUsed))
      : 0;
  const remaining = maxRepeats > 0 ? Math.max(0, maxRepeats - used) : -1;
  const active = mode !== 'off' && Boolean(text) && maxRepeats > 0;
  const rounds = maxRepeats > 0 ? `${used}/${maxRepeats}` : `${used}/-`;
  const left = remaining >= 0 ? String(remaining) : 'n/a';

  return `[stopMessage:scope=${scopeLabel} text="${safeText}" mode=${mode} round=${rounds} left=${left} active=${active ? 'yes' : 'no'}]`;
}
