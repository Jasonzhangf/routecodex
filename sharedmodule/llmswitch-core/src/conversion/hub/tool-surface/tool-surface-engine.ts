import type { StageRecorder } from '../format-adapters/index.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { isJsonObject, jsonClone } from '../types/json.js';
import { mapBridgeToolsToChat, mapChatToolsToBridge } from '../../shared/tool-mapping.js';
import { buildGeminiToolsFromBridge, prepareGeminiToolsForBridge } from '../../shared/gemini-tool-utils.js';
import { mapAnthropicToolsToChat, mapChatToolsToAnthropicTools } from '../../shared/anthropic-message-utils.js';
import { convertBridgeInputToChatMessages, convertMessagesToBridgeInput } from '../../bridge-message-utils.js';
import { resolveHubProtocolSpec, type ToolDefinitionFormat, type ProviderOutboundHistoryCarrier } from '../policy/protocol-spec.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

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

function stableStringify(value: unknown): string {
  const normalize = (node: unknown): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((entry) => normalize(entry));
    }
    if (isJsonObject(node as JsonValue)) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(node).sort();
      for (const key of keys) {
        out[key] = normalize((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

type CanonicalToolShape = {
  name: string;
  description?: string;
  parameters?: unknown;
};

type CanonicalToolCallSignature = {
  id?: string;
  name: string;
  argsType?: 'string' | 'object' | 'other';
  argsLen?: number;
};

type CanonicalToolResultSignature = {
  toolCallId?: string;
  contentLen?: number;
};

type CanonicalToolHistorySignature = {
  toolCalls: CanonicalToolCallSignature[];
  toolResults: CanonicalToolResultSignature[];
};

function extractToolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return undefined;
  }
  const obj = tool as Record<string, unknown>;
  const fnNode =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : undefined;
  const nameCandidate = fnNode?.name ?? obj.name;
  if (typeof nameCandidate === 'string' && nameCandidate.trim().length) {
    return nameCandidate.trim();
  }
  const typeRaw = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
  if (typeRaw === 'web_search' || typeRaw.startsWith('web_search')) {
    return 'web_search';
  }
  return undefined;
}

function extractToolSchema(tool: unknown): CanonicalToolShape | undefined {
  const name = extractToolName(tool);
  if (!name) return undefined;
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return { name };
  }
  const obj = tool as Record<string, unknown>;
  const fnNode =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : undefined;
  const description =
    typeof fnNode?.description === 'string'
      ? fnNode.description
      : typeof obj.description === 'string'
        ? (obj.description as string)
        : undefined;
  const parameters =
    fnNode && Object.prototype.hasOwnProperty.call(fnNode, 'parameters')
      ? fnNode.parameters
      : Object.prototype.hasOwnProperty.call(obj, 'parameters')
        ? obj.parameters
        : Object.prototype.hasOwnProperty.call(obj, 'input_schema')
          ? obj.input_schema
        : undefined;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(parameters !== undefined ? { parameters } : {})
  };
}

function parseToolsForDiff(raw: unknown): Map<string, CanonicalToolShape> {
  const map = new Map<string, CanonicalToolShape>();
  if (!Array.isArray(raw)) {
    return map;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const declarations = Array.isArray(obj.functionDeclarations) ? obj.functionDeclarations : undefined;
    if (declarations && declarations.length) {
      for (const decl of declarations) {
        const schema = extractToolSchema({ type: 'function', function: decl });
        if (schema && !map.has(schema.name)) {
          map.set(schema.name, schema);
        }
      }
      continue;
    }
    const schema = extractToolSchema(entry);
    if (schema && !map.has(schema.name)) {
      map.set(schema.name, schema);
    }
  }
  return map;
}

function computeToolSchemaDiff(
  baselineTools: unknown,
  candidateTools: unknown
): { diffCount: number; diffHead: Array<Record<string, unknown>> } {
  const baseline = parseToolsForDiff(baselineTools);
  const candidate = parseToolsForDiff(candidateTools);
  const names = Array.from(new Set([...baseline.keys(), ...candidate.keys()])).sort();

  let diffCount = 0;
  const diffHead: Array<Record<string, unknown>> = [];
  const pushHead = (entry: Record<string, unknown>): void => {
    if (diffHead.length < 10) {
      diffHead.push(entry);
    }
  };

  for (const name of names) {
    const a = baseline.get(name);
    const b = candidate.get(name);
    if (!a && b) {
      diffCount += 1;
      pushHead({ name, kind: 'missing_in_baseline' });
      continue;
    }
    if (a && !b) {
      diffCount += 1;
      pushHead({ name, kind: 'missing_in_candidate' });
      continue;
    }
    if (!a || !b) {
      continue;
    }
    const aSig = stableStringify({ description: a.description, parameters: a.parameters });
    const bSig = stableStringify({ description: b.description, parameters: b.parameters });
    if (aSig !== bSig) {
      diffCount += 1;
      pushHead({
        name,
        kind: 'schema_mismatch',
        baseline: jsonClone(a as unknown as JsonValue),
        candidate: jsonClone(b as unknown as JsonValue)
      });
    }
  }

  return { diffCount, diffHead };
}

function extractToolHistoryFromChatMessages(messages: unknown): CanonicalToolHistorySignature {
  const out: CanonicalToolHistorySignature = { toolCalls: [], toolResults: [] };
  if (!Array.isArray(messages)) return out;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const record = msg as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : '';

    if (role === 'assistant') {
      const toolCalls = Array.isArray((record as any).tool_calls) ? ((record as any).tool_calls as any[]) : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const id = typeof (tc as any).id === 'string' && (tc as any).id.trim().length ? String((tc as any).id) : undefined;
        const fn = (tc as any).function;
        const name = typeof fn?.name === 'string' ? String(fn.name).trim() : '';
        const args = fn?.arguments;
        const argsType =
          typeof args === 'string' ? 'string' : args && typeof args === 'object' && !Array.isArray(args) ? 'object' : 'other';
        const argsLen = typeof args === 'string' ? args.length : undefined;
        if (name) {
          out.toolCalls.push({ id, name, argsType, argsLen });
        }
      }
    }

    if (role === 'tool') {
      const toolCallId =
        typeof (record as any).tool_call_id === 'string'
          ? String((record as any).tool_call_id).trim()
          : typeof (record as any).call_id === 'string'
            ? String((record as any).call_id).trim()
            : undefined;
      const content = (record as any).content;
      const contentLen = typeof content === 'string' ? content.length : undefined;
      out.toolResults.push({ toolCallId: toolCallId || undefined, contentLen });
    }
  }

  return out;
}

function extractToolHistoryFromResponsesInputItems(input: unknown): CanonicalToolHistorySignature {
  const out: CanonicalToolHistorySignature = { toolCalls: [], toolResults: [] };
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
    if (type === 'function_call') {
      const id =
        typeof (rec as any).call_id === 'string' && String((rec as any).call_id).trim().length
          ? String((rec as any).call_id).trim()
          : typeof rec.id === 'string' && rec.id.trim().length
            ? rec.id.trim()
            : undefined;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      const args = (rec as any).arguments;
      const argsType =
        typeof args === 'string' ? 'string' : args && typeof args === 'object' && !Array.isArray(args) ? 'object' : 'other';
      const argsLen = typeof args === 'string' ? args.length : undefined;
      if (name) {
        out.toolCalls.push({ id, name, argsType, argsLen });
      }
      continue;
    }
    if (type === 'function_call_output') {
      const toolCallId =
        typeof (rec as any).call_id === 'string' && String((rec as any).call_id).trim().length
          ? String((rec as any).call_id).trim()
          : typeof (rec as any).tool_call_id === 'string' && String((rec as any).tool_call_id).trim().length
            ? String((rec as any).tool_call_id).trim()
            : undefined;
      const output = (rec as any).output;
      const contentLen = typeof output === 'string' ? output.length : undefined;
      out.toolResults.push({ toolCallId: toolCallId || undefined, contentLen });
      continue;
    }
  }
  return out;
}

function computeToolHistoryDiff(
  baseline: CanonicalToolHistorySignature,
  candidate: CanonicalToolHistorySignature
): { diffCount: number; diffHead: Array<Record<string, unknown>> } {
  let diffCount = 0;
  const diffs: Array<Record<string, unknown>> = [];
  const push = (entry: Record<string, unknown>) => {
    diffCount += 1;
    if (diffs.length < 10) diffs.push(entry);
  };

  const compareSeq = (a: any[], b: any[], kind: string) => {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const ai = a[i];
      const bi = b[i];
      if (ai === undefined && bi !== undefined) {
        push({ kind, index: i, type: 'missing_in_baseline', candidate: bi });
        continue;
      }
      if (ai !== undefined && bi === undefined) {
        push({ kind, index: i, type: 'missing_in_candidate', baseline: ai });
        continue;
      }
      const aSig = stableStringify(ai);
      const bSig = stableStringify(bi);
      if (aSig !== bSig) {
        push({ kind, index: i, type: 'mismatch', baseline: ai, candidate: bi });
      }
    }
  };

  compareSeq(baseline.toolCalls, candidate.toolCalls, 'tool_calls');
  compareSeq(baseline.toolResults, candidate.toolResults, 'tool_results');

  return { diffCount, diffHead: diffs };
}

function looksLikeOpenAITools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return typeof obj.type === 'string' || (obj.function && typeof obj.function === 'object');
  });
}

function looksLikeGeminiTools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return Array.isArray(obj.functionDeclarations);
  });
}

function looksLikeAnthropicTools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return typeof obj.name === 'string' && Object.prototype.hasOwnProperty.call(obj, 'input_schema');
  });
}

type DetectedToolFormat = ToolDefinitionFormat | 'unknown';

function detectToolFormat(raw: unknown): DetectedToolFormat {
  if (!Array.isArray(raw)) return 'unknown';
  if (looksLikeGeminiTools(raw)) return 'gemini';
  if (looksLikeAnthropicTools(raw)) return 'anthropic';
  if (looksLikeOpenAITools(raw)) return 'openai';
  return 'unknown';
}

function convertToolDefinitions(args: {
  from: ToolDefinitionFormat;
  to: ToolDefinitionFormat;
  tools: unknown;
}): JsonValue | undefined {
  if (!Array.isArray(args.tools)) {
    return undefined;
  }
  const from = args.from;
  const to = args.to;
  const raw = args.tools;

  if (from === to) {
    return raw as unknown as JsonValue;
  }

  // All conversions pass through OpenAI-format as the canonical bridge.
  const toOpenAI = (sourceFormat: ToolDefinitionFormat, input: unknown): unknown | undefined => {
    if (!Array.isArray(input)) return undefined;
    if (sourceFormat === 'openai') {
      return input;
    }
    if (sourceFormat === 'gemini') {
      if (!looksLikeGeminiTools(input)) return undefined;
      const bridgeDefs = prepareGeminiToolsForBridge(input as JsonValue | undefined);
      return mapBridgeToolsToChat(bridgeDefs);
    }
    if (sourceFormat === 'anthropic') {
      if (!looksLikeAnthropicTools(input)) return undefined;
      return mapAnthropicToolsToChat(input);
    }
    return undefined;
  };

  const fromOpenAI = (targetFormat: ToolDefinitionFormat, input: unknown): unknown | undefined => {
    if (!Array.isArray(input)) return undefined;
    if (targetFormat === 'openai') {
      return input;
    }
    if (targetFormat === 'gemini') {
      if (!looksLikeOpenAITools(input)) return undefined;
      const bridgeDefs = mapChatToolsToBridge(input);
      return buildGeminiToolsFromBridge(bridgeDefs);
    }
    if (targetFormat === 'anthropic') {
      if (!looksLikeOpenAITools(input)) return undefined;
      return mapChatToolsToAnthropicTools(input);
    }
    return undefined;
  };

  const openaiTools = toOpenAI(from, raw);
  if (!openaiTools) {
    return undefined;
  }
  const converted = fromOpenAI(to, openaiTools);
  if (!converted) {
    return undefined;
  }
  return converted as unknown as JsonValue;
}

function resolveExpectedHistoryCarrier(providerProtocol: string): ProviderOutboundHistoryCarrier | null {
  try {
    const spec = resolveHubProtocolSpec(providerProtocol);
    return spec.toolSurface.expectedHistoryCarrier ?? null;
  } catch {
    return null;
  }
}

function buildCandidateTools(args: {
  providerProtocol: string;
  tools: unknown;
}): { candidateTools: JsonValue | undefined; reason?: string } | undefined {
  const rawTools = args.tools;
  if (!Array.isArray(rawTools)) {
    return undefined;
  }

  const spec = resolveHubProtocolSpec(args.providerProtocol);
  const expected = spec.toolSurface.expectedToolFormat;
  const detected = detectToolFormat(rawTools);
  if (detected === 'unknown' || detected === expected) {
    return undefined;
  }

  const candidateTools = convertToolDefinitions({
    from: detected,
    to: expected,
    tools: rawTools
  });
  if (candidateTools === undefined) {
    return undefined;
  }

  return {
    candidateTools,
    reason: `${detected}_tools_on_${expected}_protocol`
  };
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
  const schemaDiff = candidate ? computeToolSchemaDiff(tools, toolSchemaCandidate) : { diffCount: 0, diffHead: [] as any[] };

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
