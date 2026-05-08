import type { JsonObject } from '../../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { cloneJson } from '../server-side-tools.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  buildReasoningStopFinalizedPayload
} from './reasoning-stop-validator.js';
import {
  REASONING_STOP_SUMMARY_ALLOWED_PREFIXES
} from './reasoning-stop-schema.js';
import {
  parseReasoningStopSummary
} from './reasoning-stop-summary-codec.js';
import type { ReasoningStopMode } from './reasoning-stop-state.js';

const REASONING_STOP_FINALIZED_MARKER = '[app.finished:reasoning.stop]';
const REASONING_STOP_BLOCK_MARKER = '[reasoning.stop]';

function buildReasoningStopFinalizedMarker(summary: string): string {
  return `${REASONING_STOP_FINALIZED_MARKER} ${JSON.stringify(
    buildReasoningStopFinalizedPayload(parseReasoningStopSummary(summary))
  )}`;
}

export function isReasoningStopGuardEnabled(): boolean {
  const envValue =
    process.env.LLMSWITCHCORE_REASONING_STOP_GUARD_ENABLED ??
    process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED ??
    process.env.RCC_REASONING_STOP_GUARD_ENABLED;
  const normalized = typeof envValue === 'string' ? envValue.trim().toLowerCase() : '';
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return true;
}

export function readFollowupClientInjectSource(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const direct =
    typeof record.clientInjectSource === 'string' && record.clientInjectSource.trim().length
      ? record.clientInjectSource.trim()
      : '';
  if (direct) {
    return direct;
  }
  const rt = readRuntimeMetadata(record);
  const runtimeValue =
    rt && typeof (rt as Record<string, unknown>).clientInjectSource === 'string'
      ? String((rt as Record<string, unknown>).clientInjectSource).trim()
      : '';
  return runtimeValue;
}

export function shouldSkipGuardForReasoningOnlyResponse(base: JsonObject): boolean {
  const choices = Array.isArray((base as any).choices) ? ((base as any).choices as unknown[]) : [];
  if (choices.length === 0) {
    return false;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return false;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string' && content.trim() === '') {
    return true;
  }
  return false;
}

export function shouldDeferToStopMessageAuto(adapterContext: unknown): boolean {
  const stopCompare = readStopMessageCompareContext(adapterContext);
  if (!stopCompare) {
    return false;
  }
  return stopCompare.armed === true;
}

function collectAssistantTextCandidates(base: JsonObject): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  };

  const choices = Array.isArray((base as any).choices) ? ((base as any).choices as unknown[]) : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    push((message as Record<string, unknown>).content);
  }

  const output = Array.isArray((base as any).output) ? ((base as any).output as unknown[]) : [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const itemType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (itemType !== 'message' || role !== 'assistant') {
      continue;
    }
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const record = part as Record<string, unknown>;
      push(record.text);
      push(record.output_text);
    }
  }

  push((base as any).output_text);
  return out;
}

export function extractEmbeddedReasoningStopSummary(base: JsonObject): string {
  const candidates = collectAssistantTextCandidates(base);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const text = candidates[i];
    const markerIndex = text.lastIndexOf(REASONING_STOP_BLOCK_MARKER);
    if (markerIndex < 0) {
      continue;
    }
    const block = text.slice(markerIndex + REASONING_STOP_BLOCK_MARKER.length);
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      continue;
    }
    const collected: string[] = [];
    for (const line of lines) {
      if (REASONING_STOP_SUMMARY_ALLOWED_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        collected.push(line);
        continue;
      }
      if (collected.length > 0) {
        break;
      }
    }
    if (collected.length > 0) {
      return collected.join('\n');
    }
  }
  return '';
}

export function appendReasoningStopSummaryToChatResponse(base: JsonObject, summary: string): JsonObject {
  const rawSummary = typeof summary === 'string' ? summary.trim() : '';
  const markerLine = rawSummary ? `结束标记: ${buildReasoningStopFinalizedMarker(rawSummary)}` : '';
  const normalizedSummary = rawSummary
    ? rawSummary.includes(REASONING_STOP_FINALIZED_MARKER)
      ? rawSummary
      : `${rawSummary}\n${markerLine}`
    : '';
  if (!normalizedSummary) {
    return base;
  }
  const cloned = cloneJson(base) as JsonObject;
  const block = `[reasoning.stop]\n${normalizedSummary}`;
  const choices = Array.isArray((cloned as any).choices) ? ((cloned as any).choices as unknown[]) : [];
  if (choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const message =
        (first as Record<string, unknown>).message &&
        typeof (first as Record<string, unknown>).message === 'object' &&
        !Array.isArray((first as Record<string, unknown>).message)
          ? ((first as Record<string, unknown>).message as Record<string, unknown>)
          : null;
      if (message) {
        const rawContent = typeof message.content === 'string' ? message.content.trim() : '';
        if (rawContent.includes(REASONING_STOP_FINALIZED_MARKER)) {
          return cloned;
        }
        message.content = rawContent ? `${rawContent}\n\n${block}` : block;
        return cloned;
      }
    }
  }
  const output = Array.isArray((cloned as any).output) ? ((cloned as any).output as unknown[]) : [];
  if (output.length > 0) {
    for (const item of output) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const itemType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
      const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
      if (itemType !== 'message' || role !== 'assistant') {
        continue;
      }
      const content = Array.isArray(row.content) ? [...row.content] : [];
      const hasMarker = content.some((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          return false;
        }
        const text = typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : typeof (part as Record<string, unknown>).output_text === 'string'
            ? String((part as Record<string, unknown>).output_text)
            : '';
        return text.includes(REASONING_STOP_FINALIZED_MARKER);
      });
      if (!hasMarker) {
        content.push({ type: 'output_text', text: block });
      }
      row.content = content;
      const outputText = typeof (cloned as any).output_text === 'string'
        ? String((cloned as any).output_text).trim()
        : '';
      (cloned as any).output_text = outputText ? `${outputText}\n\n${block}` : block;
      return cloned;
    }
  }
  const outputText = typeof (cloned as any).output_text === 'string' ? String((cloned as any).output_text).trim() : '';
  (cloned as any).output_text = outputText ? `${outputText}\n\n${block}` : block;
  return cloned;
}

export function logReasoningStopFinalizedMarker(args: {
  requestId: string;
  mode: ReasoningStopMode;
  summary: string;
  reason:
    | 'completed'
    | 'blocked'
    | 'fail_count_exceeded'
    | 'finalized_fallback'
    | 'simple_question';
}): void {
  const marker = buildReasoningStopFinalizedMarker(args.summary);
  console.log(
    `[servertool][reasoning.stop.finalized] requestId=${args.requestId} mode=${args.mode} reason=${args.reason} marker=${marker}`
  );
}
