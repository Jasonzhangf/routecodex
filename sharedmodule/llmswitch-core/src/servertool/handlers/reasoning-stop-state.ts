import type { RoutingInstructionState } from '../../router/virtual-router/routing-instructions.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../router/virtual-router/sticky-session-store.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { resolveStopMessageSessionScope } from './stop-message-auto/runtime-utils.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';

const REASONING_STOP_SUMMARY_MAX_CHARS = 4000;
const STOPLESS_DIRECTIVE_PATTERN = /<\*\*stopless:([a-z0-9_-]+)\*\*>/gi;
const STOPLESS_DIRECTIVE_STRIP_PATTERN = /<\*\*stopless:[^*]+\*\*>/gi;

export type ReasoningStopMode = 'on' | 'off' | 'endless';

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
   reasoningStopMode: undefined,
   reasoningStopArmed: undefined,
   reasoningStopSummary: undefined,
   reasoningStopUpdatedAt: undefined,
    reasoningStopFailCount: undefined,
   preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function resolveStickyKey(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const runtime = readRuntimeMetadata(record);
  const scope = resolveStopMessageSessionScope(record, runtime);
  return typeof scope === 'string' ? scope.trim() : '';
}

function normalizeSummary(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= REASONING_STOP_SUMMARY_MAX_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, REASONING_STOP_SUMMARY_MAX_CHARS);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function hasReasoningStopState(state: RoutingInstructionState | null | undefined): boolean {
  if (!state) {
    return false;
  }
  const mode = normalizeReasoningStopMode((state as RoutingInstructionState).reasoningStopMode);
  if (mode) {
    return true;
  }
  if (state.reasoningStopArmed === true) {
    return true;
  }
  if (typeof state.reasoningStopSummary === 'string' && state.reasoningStopSummary.trim()) {
    return true;
  }
  return typeof state.reasoningStopUpdatedAt === 'number' && Number.isFinite(state.reasoningStopUpdatedAt);
}

function isStateEmpty(state: RoutingInstructionState): boolean {
  const noForced = !state.forcedTarget;
  const noSticky = !state.stickyTarget;
  const noPrefer = !state.preferTarget;
  const noAllowed = state.allowedProviders.size === 0;
  const noDisabledProviders = state.disabledProviders.size === 0;
  const noDisabledKeys = state.disabledKeys.size === 0;
  const noDisabledModels = state.disabledModels.size === 0;
  const noStopMessage =
    (!state.stopMessageText || !state.stopMessageText.trim()) &&
    (typeof state.stopMessageMaxRepeats !== 'number' || !Number.isFinite(state.stopMessageMaxRepeats)) &&
    (typeof state.stopMessageUsed !== 'number' || !Number.isFinite(state.stopMessageUsed)) &&
    (typeof state.stopMessageStageMode !== 'string' || !state.stopMessageStageMode.trim()) &&
    (typeof state.stopMessageAiMode !== 'string' || !state.stopMessageAiMode.trim());
  const noReasoningStop =
    (typeof state.reasoningStopMode !== 'string' || !state.reasoningStopMode.trim()) &&
    state.reasoningStopArmed !== true &&
    (typeof state.reasoningStopUpdatedAt !== 'number' || !Number.isFinite(state.reasoningStopUpdatedAt)) &&
    (typeof state.reasoningStopFailCount !== 'number' || !Number.isFinite(state.reasoningStopFailCount));
    (typeof state.reasoningStopUpdatedAt !== 'number' || !Number.isFinite(state.reasoningStopUpdatedAt));
  const noPreCommand =
    (!state.preCommandScriptPath || !state.preCommandScriptPath.trim()) &&
    (typeof state.preCommandUpdatedAt !== 'number' || !Number.isFinite(state.preCommandUpdatedAt));

  return (
    noForced &&
    noSticky &&
    noPrefer &&
    noAllowed &&
    noDisabledProviders &&
    noDisabledKeys &&
    noDisabledModels &&
    noStopMessage &&
    noReasoningStop &&
    noPreCommand
  );
}

function normalizeReasoningStopMode(value: unknown): ReasoningStopMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'endless') {
    return normalized;
  }
  return undefined;
}

function extractMessageContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (text) {
        parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function extractLatestUserTextFromCapturedRequest(source: unknown): string {
  const seed = extractCapturedChatSeed(source);
  if (!seed || !Array.isArray(seed.messages) || seed.messages.length === 0) {
    return '';
  }
  for (let i = seed.messages.length - 1; i >= 0; i -= 1) {
    const msg = seed.messages[i];
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    const role = typeof (msg as Record<string, unknown>).role === 'string'
      ? String((msg as Record<string, unknown>).role).trim().toLowerCase()
      : '';
    if (role !== 'user') {
      continue;
    }
    const content = (msg as Record<string, unknown>).content;
    const text = extractMessageContentText(content);
    if (text) {
      return text;
    }
  }
  return '';
}

function extractStoplessDirectiveModeFromText(text: string): ReasoningStopMode | undefined {
  const source = typeof text === 'string' ? text : '';
  if (!source) {
    return undefined;
  }
  STOPLESS_DIRECTIVE_PATTERN.lastIndex = 0;
  let matched: ReasoningStopMode | undefined;
  for (const match of source.matchAll(STOPLESS_DIRECTIVE_PATTERN)) {
    const mode = normalizeReasoningStopMode(match[1]);
    if (mode) {
      matched = mode;
    }
  }
  return matched;
}

function stripStoplessDirectiveMarkersFromText(text: string): { text: string; stripped: boolean } {
  if (typeof text !== 'string' || !text) {
    return { text: '', stripped: false };
  }
  let stripped = false;
  STOPLESS_DIRECTIVE_STRIP_PATTERN.lastIndex = 0;
  const replaced = text.replace(STOPLESS_DIRECTIVE_STRIP_PATTERN, () => {
    stripped = true;
    return ' ';
  });
  if (!stripped) {
    return { text, stripped: false };
  }
  const compacted = replaced
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: compacted, stripped: true };
}

function stripStoplessDirectiveMarkersFromContent(content: unknown): {
  content: unknown;
  stripped: boolean;
} {
  if (typeof content === 'string') {
    const stripped = stripStoplessDirectiveMarkersFromText(content);
    return { content: stripped.text, stripped: stripped.stripped };
  }
  if (!Array.isArray(content)) {
    return { content, stripped: false };
  }
  const nextContent: unknown[] = [];
  let strippedAny = false;
  for (const item of content) {
    if (typeof item === 'string') {
      const stripped = stripStoplessDirectiveMarkersFromText(item);
      if (stripped.stripped) {
        strippedAny = true;
      }
      nextContent.push(stripped.text);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      nextContent.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string') {
      nextContent.push(item);
      continue;
    }
    const stripped = stripStoplessDirectiveMarkersFromText(record.text);
    if (!stripped.stripped) {
      nextContent.push(item);
      continue;
    }
    strippedAny = true;
    nextContent.push({
      ...record,
      text: stripped.text
    });
  }
  return {
    content: nextContent,
    stripped: strippedAny
  };
}

function stripStoplessDirectiveMarkersInMessages(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  let strippedAny = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const role = typeof (message as Record<string, unknown>).role === 'string'
      ? String((message as Record<string, unknown>).role).trim().toLowerCase()
      : '';
    if (role !== 'user') {
      continue;
    }
    const originalContent = (message as Record<string, unknown>).content;
    const stripped = stripStoplessDirectiveMarkersFromContent(originalContent);
    if (!stripped.stripped) {
      continue;
    }
    strippedAny = true;
    (message as Record<string, unknown>).content = stripped.content;
  }
  return strippedAny;
}

function stripStoplessDirectiveMarkersFromCapturedRequest(source: unknown): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return false;
  }
  const record = source as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? (record.messages as unknown[]) : [];
  const input = Array.isArray(record.input) ? (record.input as unknown[]) : [];
  const strippedInMessages = stripStoplessDirectiveMarkersInMessages(messages);
  const strippedInInput = stripStoplessDirectiveMarkersInMessages(input);
  return strippedInMessages || strippedInInput;
}

function extractStoplessDirectiveModeFromAdapterContext(adapterContext: unknown): ReasoningStopMode | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const captured = record.capturedChatRequest;
  const text = extractLatestUserTextFromCapturedRequest(captured);
  const mode = extractStoplessDirectiveModeFromText(text);
  // Marker is transport control signal and must never leak into followup payloads,
  // regardless of whether parsing succeeds.
  stripStoplessDirectiveMarkersFromCapturedRequest(captured);
  return mode;
}

export function readReasoningStopMode(adapterContext: unknown): ReasoningStopMode {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 'off';
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    return 'off';
  }
  return normalizeReasoningStopMode(state?.reasoningStopMode) ?? 'off';
}

export function syncReasoningStopModeFromRequest(adapterContext: unknown): ReasoningStopMode {
  const stickyKey = resolveStickyKey(adapterContext);
  const directiveMode = extractStoplessDirectiveModeFromAdapterContext(adapterContext);
  if (!stickyKey) {
    // stopless switch is strictly session-bound. If we cannot bind a session scope,
    // the directive must be ignored.
    return 'off';
  }

  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }

  const persistedMode = normalizeReasoningStopMode(state?.reasoningStopMode) ?? 'off';
  if (!directiveMode) {
    return persistedMode;
  }

  const next = state ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = directiveMode;
  if (directiveMode === 'off') {
    next.reasoningStopArmed = undefined;
    next.reasoningStopSummary = undefined;
    next.reasoningStopUpdatedAt = undefined;
  }
  saveRoutingInstructionStateSync(stickyKey, next);
  return directiveMode;
}

export function readReasoningStopState(adapterContext: unknown): {
  stickyKey: string;
  armed: boolean;
  summary: string;
  updatedAt?: number;
} {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return { stickyKey: '', armed: false, summary: '' };
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    return { stickyKey, armed: false, summary: '' };
  }
  if (!hasReasoningStopState(state)) {
    return { stickyKey, armed: false, summary: '' };
  }
  const summary = normalizeSummary(state?.reasoningStopSummary);
  const updatedAt = readNumber(state?.reasoningStopUpdatedAt);
  return {
    stickyKey,
    armed: state?.reasoningStopArmed === true && summary.length > 0,
    summary,
    ...(typeof updatedAt === 'number' ? { updatedAt } : {})
  };
}

export function armReasoningStopState(adapterContext: unknown, summary: string): boolean {
  const stickyKey = resolveStickyKey(adapterContext);
  const normalizedSummary = normalizeSummary(summary);
  if (!stickyKey || !normalizedSummary) {
    return false;
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  const next = state ?? createEmptyRoutingInstructionState();
  next.reasoningStopArmed = true;
  next.reasoningStopSummary = normalizedSummary;
  next.reasoningStopUpdatedAt = Date.now();
  saveRoutingInstructionStateSync(stickyKey, next);
  return true;
}

export function clearReasoningStopState(adapterContext: unknown): void {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return;
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  if (!state) {
    return;
  }
 state.reasoningStopArmed = undefined;
 state.reasoningStopSummary = undefined;
 state.reasoningStopUpdatedAt = undefined;
  state.reasoningStopFailCount = undefined;
 if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}

export function readReasoningStopFailCount(adapterContext: unknown): number {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 0;
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  if (!state) {
    return 0;
  }
  const count = state.reasoningStopFailCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

export function incrementReasoningStopFailCount(adapterContext: unknown): number {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 0;
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  const next = state ?? createEmptyRoutingInstructionState();
  const currentCount = typeof next.reasoningStopFailCount === 'number' && Number.isFinite(next.reasoningStopFailCount)
    ? next.reasoningStopFailCount
    : 0;
  const newCount = currentCount + 1;
  next.reasoningStopFailCount = newCount;
  saveRoutingInstructionStateSync(stickyKey, next);
  return newCount;
}

export function resetReasoningStopFailCount(adapterContext: unknown): void {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return;
  }
  let state: RoutingInstructionState | null = null;
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  if (!state) {
    return;
  }
  state.reasoningStopFailCount = undefined;
  if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}
