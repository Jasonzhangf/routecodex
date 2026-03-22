import type { StageRecorder } from '../format-adapters/index.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { jsonClone } from '../types/json.js';
import { convertBridgeInputToChatMessages, convertMessagesToBridgeInput } from '../../bridge-message-utils.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { buildCandidateTools, resolveExpectedHistoryCarrier } from './tool-surface-convert.js';
import {
  computeToolHistoryDiff,
  computeToolSchemaDiff,
  extractToolHistoryFromChatMessages,
  extractToolHistoryFromResponsesInputItems,
  type CanonicalToolHistorySignature
} from './tool-surface-diff.js';

export type HubToolSurfaceMode = 'off' | 'observe' | 'shadow' | 'enforce';

export interface HubToolSurfaceConfig {
  mode: HubToolSurfaceMode;
  /**
   * Range: 0..1. When omitted, defaults to 1 (always on for the selected mode).
   * Sampling is request-id stable to avoid non-deterministic diffs.
   */
  sampleRate?: number;
}

function clampSampleRate(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function shouldSample(config: HubToolSurfaceConfig | undefined, requestId: string | undefined): boolean {
  if (!config) return false;
  if (config.mode === 'off') return false;
  const rate = clampSampleRate(config.sampleRate);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const key = typeof requestId === 'string' && requestId.trim().length ? requestId.trim() : 'no_request_id';
  const bucket = fnv1a32(key) / 0xffffffff;
  return bucket < rate;
}

export function applyProviderOutboundToolSurface(args: {
  config?: HubToolSurfaceConfig;
  providerProtocol: string;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
  requestId?: string;
}): JsonObject {
  const config = args.config;
  if (!config || config.mode === 'off') {
    return args.payload;
  }
  if (!shouldSample(config, args.requestId)) {
    return args.payload;
  }

  const normalizedProviderProtocol =
    normalizeProviderProtocolTokenWithNative(args.providerProtocol) ?? args.providerProtocol;
  const payload = args.payload;
  const tools = (payload as { tools?: unknown }).tools;
  const candidate = buildCandidateTools({ providerProtocol: normalizedProviderProtocol, tools });
  if (!candidate) {
    // Still allow history/tool-call surface observation even when tool definitions don't need conversion.
  }

  const stageBase = `hub_toolsurface.${config.mode}.provider_outbound`;

  const toolSchemaCandidate = candidate?.candidateTools;
  const schemaDiff = candidate
    ? computeToolSchemaDiff(tools, toolSchemaCandidate)
    : { diffCount: 0, diffHead: [] as Array<Record<string, unknown>> };

  const expectedHistoryCarrier = resolveExpectedHistoryCarrier(normalizedProviderProtocol);
  let historyReason: string | undefined = undefined;
  let historyBaseline: CanonicalToolHistorySignature | undefined = undefined;
  let historyCandidate: CanonicalToolHistorySignature | undefined = undefined;
  let historyDiff = { diffCount: 0, diffHead: [] as Array<Record<string, unknown>> };

  // Phase 2 (shadow): detect tool call/result history carriers drifting between
  // Chat messages and Responses input shapes.
  try {
    if (expectedHistoryCarrier === 'input') {
      const messages = (payload as any).messages;
      const input = (payload as any).input;
      if (Array.isArray(messages) && !Array.isArray(input)) {
        const bridge = convertMessagesToBridgeInput({
          messages: messages as Array<Record<string, unknown>>,
          tools: Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : undefined
        });
        historyReason = 'openai_chat_messages_on_responses_protocol';
        historyBaseline = extractToolHistoryFromChatMessages(messages);
        historyCandidate = extractToolHistoryFromResponsesInputItems(bridge.input);
        historyDiff = computeToolHistoryDiff(historyBaseline, historyCandidate);
      }
    } else if (expectedHistoryCarrier === 'messages') {
      const messages = (payload as any).messages;
      const input = (payload as any).input;
      if (!Array.isArray(messages) && Array.isArray(input)) {
        historyReason = 'responses_input_on_openai_chat_protocol';
        historyBaseline = extractToolHistoryFromResponsesInputItems(input);
        historyCandidate = extractToolHistoryFromChatMessages(
          convertBridgeInputToChatMessages({
            input: input as any[],
            tools: Array.isArray(tools) ? (tools as any[]) : undefined
          })
        );
        historyDiff = computeToolHistoryDiff(historyBaseline, historyCandidate);
      }
    }
  } catch {
    // best-effort only
  }

  const totalDiffCount = (schemaDiff.diffCount || 0) + (historyDiff.diffCount || 0);
  const shouldRecord = totalDiffCount > 0 || Boolean(candidate?.candidateTools) || Boolean(historyReason);
  if (shouldRecord) {
    const diffHeadMerged: Array<Record<string, unknown>> = [];
    for (const entry of schemaDiff.diffHead) {
      if (diffHeadMerged.length >= 10) break;
      diffHeadMerged.push({ area: 'tool_definitions', ...entry });
    }
    for (const entry of historyDiff.diffHead) {
      if (diffHeadMerged.length >= 10) break;
      diffHeadMerged.push({ area: 'tool_history', ...entry });
    }
    args.stageRecorder?.record(stageBase, {
      kind: 'provider_outbound',
      providerProtocol: normalizedProviderProtocol,
      reason: candidate?.reason ?? historyReason,
      diffCount: totalDiffCount,
      diffHead: diffHeadMerged,
      ...(schemaDiff.diffCount > 0
        ? {
            definitionDiffCount: schemaDiff.diffCount,
            definitionDiffHead: schemaDiff.diffHead,
            ...(tools !== undefined ? { baselineTools: jsonClone(tools as JsonValue) } : {}),
            ...(toolSchemaCandidate !== undefined ? { candidateTools: jsonClone(toolSchemaCandidate as JsonValue) } : {})
          }
        : {}),
      ...(historyDiff.diffCount > 0
        ? {
            historyDiffCount: historyDiff.diffCount,
            historyDiffHead: historyDiff.diffHead,
            historyReason,
            historyBaseline,
            historyCandidate
          }
        : {})
    });
  }

  if (config.mode === 'enforce') {
    let next: JsonObject | null = null;
    const ensureClone = () => {
      if (!next) {
        next = jsonClone(payload as JsonValue) as JsonObject;
      }
      return next;
    };

    if (candidate && candidate.candidateTools !== undefined) {
      (ensureClone() as any).tools = candidate.candidateTools;
    }

    // Best-effort: normalize history carrier when we can reconstruct a canonical representation.
    try {
      if (expectedHistoryCarrier === 'input') {
        const messages = (payload as any).messages;
        const input = (payload as any).input;
        if (Array.isArray(messages) && !Array.isArray(input)) {
          const bridge = convertMessagesToBridgeInput({
            messages: messages as Array<Record<string, unknown>>,
            tools: Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : undefined
          });
          (ensureClone() as any).input = bridge.input as any;
          try {
            delete (ensureClone() as any).messages;
          } catch {
            (ensureClone() as any).messages = undefined;
          }
        }
      } else if (expectedHistoryCarrier === 'messages') {
        const messages = (payload as any).messages;
        const input = (payload as any).input;
        if (!Array.isArray(messages) && Array.isArray(input)) {
          const convertedMessages = convertBridgeInputToChatMessages({
            input: input as any[],
            tools: Array.isArray(tools) ? (tools as any[]) : undefined
          });
          (ensureClone() as any).messages = convertedMessages as any;
          try {
            delete (ensureClone() as any).input;
          } catch {
            (ensureClone() as any).input = undefined;
          }
        }
      }
    } catch {
      // best-effort only
    }

    return next ?? payload;
  }

  return payload;
}
