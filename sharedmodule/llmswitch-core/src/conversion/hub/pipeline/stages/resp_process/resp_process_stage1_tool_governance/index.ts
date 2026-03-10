import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ChatCompletionLike } from '../../../../response/response-mappers.js';
import { runChatResponseToolFilters } from '../../../../../shared/tool-filter-pipeline.js';
import { buildChatResponseFromResponses } from '../../../../../shared/responses-response-utils.js';
import { normalizeAssistantTextToToolCalls, type TextMarkupNormalizeOptions } from '../../../../../shared/text-markup-normalizer.js';
import { recordStage } from '../../../stages/utils.js';
import {
  applyRespProcessToolGovernanceWithNative,
  stripOrphanFunctionCallsTagWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

const SHELL_TOOL_NAME_ALIASES: Record<string, string> = {};

/**
 * Unified text-to-tool-calls harvest config.
 * Shared across all providers via chat process tool governance.
 */
const DEFAULT_TEXT_NORMALIZER_CONFIG: TextMarkupNormalizeOptions = {
  jsonToolRepair: {
    toolNameAliases: SHELL_TOOL_NAME_ALIASES,
    argumentAliases: {
      exec_command: {
        cmd: ['cmd', 'command', 'input.command', 'script'],
        command: ['cmd', 'command', 'input.command', 'script'],
        workdir: ['workdir', 'cwd', 'input.cwd']
      }
    }
  }
};

export interface RespProcessStage1ToolGovernanceOptions {
  payload: ChatCompletionLike;
  entryEndpoint: string;
  requestId: string;
  clientProtocol: ClientProtocol;
  stageRecorder?: StageRecorder;
}

export interface RespProcessStage1ToolGovernanceResult {
  governedPayload: JsonObject;
}

function isCanonicalChatCompletion(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const obj = payload as any;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  if (!choices.length) return false;
  const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] : null;
  if (!first) return false;
  const msg = (first as any).message;
  return Boolean(msg && typeof msg === 'object' && !Array.isArray(msg));
}

function coerceToCanonicalChatCompletion(payload: ChatCompletionLike): ChatCompletionLike {
  if (isCanonicalChatCompletion(payload)) {
    return payload;
  }
  // ServerTool followups may re-enter via the client protocol shape (e.g. OpenAI Responses object:'response').
  // Response tool governance requires an OpenAI-chat-like surface (choices[].message) so text tool harvesting
  // and tool governance remain a single fixed path.
  try {
    const coerced = buildChatResponseFromResponses(payload);
    if (isCanonicalChatCompletion(coerced)) {
      return coerced as ChatCompletionLike;
    }
  } catch {
    // best-effort: keep original payload when bridge fails
  }
  return payload;
}

/**
 * Harvest tool calls from assistant text content when native tool_calls are missing or empty.
 * This is the single entry point for text-based tool call extraction across all providers.
 */
function harvestToolCallsFromText(payload: ChatCompletionLike): ChatCompletionLike {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const choices = Array.isArray((payload as any).choices) ? ((payload as any).choices as unknown[]) : [];
  if (!choices.length) {
    return payload;
  }

  let changed = false;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as any).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }

    // Skip if already has native tool_calls
    const existingToolCalls = Array.isArray((message as any).tool_calls) ? ((message as any).tool_calls as unknown[]) : undefined;
    if (existingToolCalls && existingToolCalls.length > 0) {
      continue;
    }

    // Try to harvest from text content
    const normalized = normalizeAssistantTextToToolCalls(
      message as Record<string, any>,
      DEFAULT_TEXT_NORMALIZER_CONFIG
    );

    const harvestedCalls = Array.isArray((normalized as any).tool_calls)
      ? ((normalized as any).tool_calls as unknown[])
      : [];

    if (harvestedCalls.length > 0) {
      (choice as any).message = normalized;
      changed = true;

      // Update finish_reason if needed
      const finish = typeof (choice as any).finish_reason === 'string'
        ? String((choice as any).finish_reason).trim().toLowerCase()
        : '';
      if (!finish || finish === 'stop') {
        (choice as any).finish_reason = 'tool_calls';
      }
    }
  }

  return changed ? payload : payload;
}

function sanitizeResponseShapeBeforeGovernance(payload: ChatCompletionLike): ChatCompletionLike {
  return stripOrphanFunctionCallsTagWithNative(payload as unknown as JsonObject) as unknown as ChatCompletionLike;
}

export async function runRespProcessStage1ToolGovernance(
  options: RespProcessStage1ToolGovernanceOptions
): Promise<RespProcessStage1ToolGovernanceResult> {
  const canonicalInput = coerceToCanonicalChatCompletion(options.payload as ChatCompletionLike);
  const shapeSanitizedInput = sanitizeResponseShapeBeforeGovernance(canonicalInput as ChatCompletionLike);

  // Single entry point for text-to-tool-calls harvest across all providers
  harvestToolCallsFromText(shapeSanitizedInput as ChatCompletionLike);

  recordStage(options.stageRecorder, 'chat_process.resp.stage6.canonicalize_chat_completion', {
    converted: canonicalInput !== options.payload,
    shapeSanitized: shapeSanitizedInput !== canonicalInput,
    canonicalPayload: shapeSanitizedInput
  });

  const filtered = await runChatResponseToolFilters(shapeSanitizedInput as JsonObject, {
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    profile: 'openai-chat'
  });
  const patchedNative = applyRespProcessToolGovernanceWithNative({
    payload: filtered as JsonObject,
    clientProtocol: options.clientProtocol,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId
  });
  const governed = patchedNative.governedPayload as JsonObject;
  recordStage(options.stageRecorder, 'chat_process.resp.stage7.tool_governance', {
    summary: patchedNative.summary,
    applied: patchedNative.summary?.applied === true,
    filteredPayload: filtered as JsonObject,
    governedPayload: governed
  });
  return { governedPayload: governed as JsonObject };
}
