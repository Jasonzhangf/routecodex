import {
  assertWindsurfRccToolResultMarkerContractWithNative,
  buildWindsurfNativeToolSignatureWithNative,
  buildWindsurfNativeAdditionalStepPayloadsWithNative,
  buildWindsurfCascadePromptTextWithNative,
  buildWindsurfRccPendingToolReminderWithNative,
  buildWindsurfRccToolGuidanceWithNative,
  buildWindsurfRccToolResultContextWithNative,
  decideWindsurfCompletedNativeToolCallPairingWithNative,
  harvestWindsurfRccToolCallsWithNative,
  parseCascadeAssistantTurnWithNative,
  parseCascadeSemanticRoundtripWithNative,
  parseCascadeToolResultTurnWithNative,
} from './native-windsurf-tool-history-projection.js';

export type WindsurfNativeToolMapping = {
  kind: string;
  forward: (args: Record<string, unknown>) => Record<string, unknown>;
  applyObservation?: (payload: Record<string, unknown>, observation: string) => void;
};

type NativeWindsurfToolHistoryCapability =
  | 'buildWindsurfRccToolResultContextJson'
  | 'assertWindsurfRccToolResultMarkerContractJson'
  | 'buildWindsurfCascadePromptTextJson'
  | 'buildWindsurfRccToolGuidanceJson'
  | 'buildWindsurfRccPendingToolReminderJson'
  | 'harvestWindsurfRccToolCallsJson';

function callNativeWindsurfToolHistoryProjection<T>(capability: NativeWindsurfToolHistoryCapability, input: Record<string, unknown>): T {
  switch (capability) {
    case 'buildWindsurfRccToolResultContextJson':
      return buildWindsurfRccToolResultContextWithNative(input as { semanticConversation: unknown[]; rccTextTools: unknown[] }) as T;
    case 'assertWindsurfRccToolResultMarkerContractJson':
      return assertWindsurfRccToolResultMarkerContractWithNative(input as { semanticConversation: unknown[]; rccTextTools: unknown[] }) as T;
    case 'buildWindsurfCascadePromptTextJson':
      return buildWindsurfCascadePromptTextWithNative(input as { messages: unknown[]; semanticConversation: unknown[]; rccTextTools: unknown[]; rccGuidance: string; rccPendingReminder: string; maxHistoryBytes: number; windsurfNativeToolNames: string[] }) as T;
    case 'buildWindsurfRccToolGuidanceJson':
      return buildWindsurfRccToolGuidanceWithNative(input as { semanticConversation: unknown[]; rccTextTools: unknown[] }) as T;
    case 'buildWindsurfRccPendingToolReminderJson':
      return buildWindsurfRccPendingToolReminderWithNative(input as { semanticConversation: unknown[]; rccTextTools: unknown[]; windsurfNativeToolNames: string[] }) as T;
    case 'harvestWindsurfRccToolCallsJson':
      return harvestWindsurfRccToolCallsWithNative(input as { text: string; rccTextTools: unknown[] }) as T;
  }
}

export type WindsurfSemanticToolCallLike = {
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type WindsurfSemanticTurnLike =
  | { type: 'function_call_output'; call_id: string; name?: string; output: string }
  | { type: 'assistant'; text?: string; tool_calls?: WindsurfSemanticToolCallLike[] }
  | { type: string; [key: string]: unknown };

export type WindsurfCompletedNativeToolPairingStrategy = {
  name: 'completed_native_tool_result_pairing';
  completedCallIds: Set<string>;
  completedSignatures: Set<string>;
};

export type WindsurfCompletedNativeToolPairingDecision =
  | { action: 'skip_completed_native_tool_call'; reason: 'inline_result_present' | 'call_id_already_completed' | 'signature_already_completed'; strategy: 'completed_native_tool_result_pairing' }
  | { action: 'emit_tool_call'; reason: 'not_completed_native_tool_call'; strategy: 'completed_native_tool_result_pairing' };

export function buildWindsurfNativeToolSignature(args: {
  kind: string;
  payload: Record<string, unknown>;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
}): string {
  void args.lookupName;
  void args.stableStringify;
  return buildWindsurfNativeToolSignatureWithNative({ kind: args.kind, payload: args.payload || {} }).signature;
}

export function buildCompletedNativeToolCallIds(semanticConversation: WindsurfSemanticTurnLike[]): string[] {
  const out = new Set<string>();
  for (const turn of semanticConversation) {
    if (turn.type !== 'function_call_output') continue;
    const id = typeof turn.call_id === 'string' ? turn.call_id.trim() : '';
    if (!id) continue;
    out.add(id);
    out.add(`fc_${id}`);
    if (id.startsWith('fc_')) {
      const stripped = id.slice(3);
      if (stripped) out.add(stripped);
    }
  }
  return Array.from(out);
}

export function buildCompletedNativeToolSignatures(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  nativeTools?: Array<Record<string, unknown>>;
  isNativeToolName: (name: string, nativeTools?: Array<Record<string, unknown>>) => boolean;
  toolMap: Record<string, WindsurfNativeToolMapping | undefined>;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
}): string[] {
  const out = new Set<string>();
  const toolResultById = new Map<string, string>();
  for (const turn of args.semanticConversation) {
    if (turn.type === 'function_call_output') {
      const callId = typeof turn.call_id === 'string' ? turn.call_id : '';
      const output = typeof turn.output === 'string' ? turn.output : '';
      if (callId) toolResultById.set(callId, output);
    }
  }
  for (const turn of args.semanticConversation) {
    if (turn.type !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
    for (const toolCall of turn.tool_calls) {
      if (!toolResultById.has(toolCall.call_id)) continue;
      if (!args.isNativeToolName(toolCall.name, args.nativeTools)) continue;
      const mapped = args.toolMap[String(toolCall.name || '').toLowerCase()];
      if (!mapped) continue;
      const payload = mapped.forward(toolCall.arguments || {});
      out.add(buildWindsurfNativeToolSignature({
        kind: mapped.kind,
        payload,
        lookupName: args.lookupName,
        stableStringify: args.stableStringify,
      }));
    }
  }
  return Array.from(out);
}

export function buildCompletedNativeToolStrategy(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  nativeTools?: Array<Record<string, unknown>>;
  isNativeToolName: (name: string, nativeTools?: Array<Record<string, unknown>>) => boolean;
  toolMap: Record<string, WindsurfNativeToolMapping | undefined>;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
}): WindsurfCompletedNativeToolPairingStrategy {
  return {
    name: 'completed_native_tool_result_pairing',
    completedCallIds: new Set(buildCompletedNativeToolCallIds(args.semanticConversation)),
    completedSignatures: new Set(buildCompletedNativeToolSignatures(args)),
  };
}

export function decideCompletedNativeToolCallPairing(args: {
  rawCall: Record<string, unknown>;
  strategy: WindsurfCompletedNativeToolPairingStrategy;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
}): WindsurfCompletedNativeToolPairingDecision {
  void args.lookupName;
  void args.stableStringify;
  const result = decideWindsurfCompletedNativeToolCallPairingWithNative({
    rawCall: args.rawCall,
    completedCallIds: Array.from(args.strategy.completedCallIds),
    completedSignatures: Array.from(args.strategy.completedSignatures),
  });
  return result as WindsurfCompletedNativeToolPairingDecision;
}

export function isCompletedNativeToolCallAlreadyPaired(args: {
  rawCall: Record<string, unknown>;
  strategy: WindsurfCompletedNativeToolPairingStrategy;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
}): boolean {
  return decideCompletedNativeToolCallPairing(args).action === 'skip_completed_native_tool_call';
}

function escapeRccCdata(value: string): string {
  return String(value || '').replaceAll(']]>', ']]]]><![CDATA[>');
}

function windsurfToolNameSet(tools: unknown, lookupName: (name: string) => string): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    const row = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool as Record<string, unknown> : undefined;
    const fn = row?.function && typeof row.function === 'object' && !Array.isArray(row.function) ? row.function as Record<string, unknown> : undefined;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (name) {
      out.add(name);
      out.add(lookupName(name));
    }
  }
  return out;
}

export function buildWindsurfRccToolResultContext(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  rccTextTools: Array<Record<string, unknown>>;
  lookupName: (name: string) => string;
}): string {
  void args.lookupName;
  const result = callNativeWindsurfToolHistoryProjection<{ context: string }>('buildWindsurfRccToolResultContextJson', {
    semanticConversation: args.semanticConversation,
    rccTextTools: args.rccTextTools,
  });
  return typeof result.context === 'string' ? result.context : '';
}

export function assertWindsurfRccToolResultMarkerContract(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  rccTextTools: Array<Record<string, unknown>>;
  lookupName: (name: string) => string;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): void {
  void args.lookupName;
  const result = callNativeWindsurfToolHistoryProjection<{ ok: boolean; missing?: string[] }>('assertWindsurfRccToolResultMarkerContractJson', {
    semanticConversation: args.semanticConversation,
    rccTextTools: args.rccTextTools,
  });
  const missing = Array.isArray(result.missing) ? result.missing : [];
  if (missing.length > 0) {
    throw args.createError(`[windsurf] RCC tool_result marker contract violated: missing ${missing.join(', ')}`, {
      code: 'WINDSURF_RCC_TOOL_RESULT_MARKER_CONTRACT_VIOLATED',
      status: 500,
      retryable: false,
    });
  }
}

export function buildWindsurfCascadePromptText(args: {
  messages: unknown[];
  semanticConversation: WindsurfSemanticTurnLike[];
  rccTextTools: Array<Record<string, unknown>>;
  rccGuidance: string;
  rccPendingReminder: string;
  maxHistoryBytes: number;
  windsurfNativeToolNames: string[];
}): string {
  const result = callNativeWindsurfToolHistoryProjection<{ prompt: string }>('buildWindsurfCascadePromptTextJson', {
    messages: args.messages,
    semanticConversation: args.semanticConversation,
    rccTextTools: args.rccTextTools,
    rccGuidance: args.rccGuidance,
    rccPendingReminder: args.rccPendingReminder,
    maxHistoryBytes: args.maxHistoryBytes,
    windsurfNativeToolNames: args.windsurfNativeToolNames,
  });
  return result.prompt;
}

export function buildWindsurfRccToolGuidance(args: {
  rccTextTools: Array<Record<string, unknown>>;
  lookupName: (name: string) => string;
}): string {
  void args.lookupName;
  const result = callNativeWindsurfToolHistoryProjection<{ guidance: string }>('buildWindsurfRccToolGuidanceJson', {
    semanticConversation: [],
    rccTextTools: args.rccTextTools,
  });
  return typeof result.guidance === 'string' ? result.guidance : '';
}

export function buildWindsurfRccPendingToolReminder(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  rccTextTools: Array<Record<string, unknown>>;
  lookupName: (name: string) => string;
  isNativeToolName: (name: string) => boolean;
  nativeToolNames: string[];
}): string {
  void args.lookupName;
  void args.isNativeToolName;
  const result = callNativeWindsurfToolHistoryProjection<{ reminder: string }>('buildWindsurfRccPendingToolReminderJson', {
    semanticConversation: args.semanticConversation,
    rccTextTools: args.rccTextTools,
    windsurfNativeToolNames: args.nativeToolNames,
  });
  return typeof result.reminder === 'string' ? result.reminder : '';
}

export function harvestWindsurfRccToolCalls(args: {
  text: string;
  rccTextTools: Array<Record<string, unknown>>;
  lookupName: (name: string) => string;
  stableStringify: (value: unknown) => string;
  hashId: (value: string) => string;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): { text: string; toolCalls: Array<Record<string, unknown>> } {
  void args.lookupName;
  void args.stableStringify;
  void args.hashId;
  const result = callNativeWindsurfToolHistoryProjection<{
    text: string;
    toolCalls: Array<Record<string, unknown>>;
    error?: { message?: string; code?: string; status?: number; retryable?: boolean };
  }>('harvestWindsurfRccToolCallsJson', {
    text: args.text,
    rccTextTools: args.rccTextTools,
  });
  if (result.error) {
    throw args.createError(String(result.error.message || '[windsurf] RCC harvest failed'), {
      code: result.error.code || 'WINDSURF_RCC_MALFORMED',
      status: typeof result.error.status === 'number' ? result.error.status : 502,
      retryable: result.error.retryable === true,
    });
  }
  return {
    text: typeof result.text === 'string' ? result.text : '',
    toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
  };
}

export function buildWindsurfNativeAdditionalStepPayloads(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  nativeTools?: Array<Record<string, unknown>>;
  isNativeToolName: (name: string, nativeTools?: Array<Record<string, unknown>>) => boolean;
  toolMap: Record<string, WindsurfNativeToolMapping | undefined>;
  lookupName: (name: string) => string;
}): Array<{ kind: string; payload: Record<string, unknown> }> {
  void args.isNativeToolName;
  void args.toolMap;
  const nativeToolNames = Array.isArray(args.nativeTools)
    ? args.nativeTools
        .map((tool) => {
          const row = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool as Record<string, unknown> : undefined;
          const fn = row?.function && typeof row.function === 'object' && !Array.isArray(row.function) ? row.function as Record<string, unknown> : undefined;
          return typeof fn?.name === 'string' ? fn.name.trim() : '';
        })
        .filter((name): name is string => Boolean(name))
    : [];
  const forwardedNativeToolNames = nativeToolNames.length > 0
    ? nativeToolNames
    : Object.keys(args.toolMap).filter((name) => Boolean(name));
  const result = buildWindsurfNativeAdditionalStepPayloadsWithNative({
    semanticConversation: args.semanticConversation,
    nativeToolNames: forwardedNativeToolNames,
  });
  return Array.isArray(result.steps)
    ? result.steps
      .filter((step): step is { kind: string; payload: Record<string, unknown> } => Boolean(step && typeof step.kind === 'string' && step.payload && typeof step.payload === 'object' && !Array.isArray(step.payload)))
      .map((step) => ({ kind: step.kind, payload: step.payload }))
    : [];
}

function readAssistantToolArguments(rawArgs: unknown): Record<string, unknown> {
  try {
    if (typeof rawArgs === 'string') {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error('[windsurf] assistant tool call arguments must be valid json object');
    }
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      return rawArgs as Record<string, unknown>;
    }
    throw new Error('[windsurf] assistant tool call arguments must be valid json object');
  } catch {
    throw new Error('[windsurf] assistant tool call arguments must be valid json object');
  }
}

export function parseCascadeAssistantTurn(args: {
  candidate: unknown;
  rccTextTools?: Array<Record<string, unknown>>;
  stableStringify: (value: unknown) => string;
  harvestRccToolCalls: (text: string, rccTextTools: Array<Record<string, unknown>>) => { text: string; toolCalls: Array<Record<string, unknown>> };
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): Record<string, unknown> {
  const record = args.candidate && typeof args.candidate === 'object' ? args.candidate as Record<string, unknown> : {};
  const rawContent = Array.isArray(record.content) ? record.content : [];
  const rawTopLevelToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const seenToolCallIds = new Set<string>();

  if (typeof record.reasoning_content === 'string' && record.reasoning_content) {
    reasoningParts.push(record.reasoning_content);
  }
  if (typeof record.content === 'string' && record.content) {
    textParts.push(record.content);
  }

  for (const entry of rawTopLevelToolCalls) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
    const callId = typeof row.id === 'string'
      ? row.id.trim()
      : typeof row.call_id === 'string'
        ? String(row.call_id).trim()
        : '';
    const name = typeof fn.name === 'string'
      ? fn.name.trim()
      : typeof row.name === 'string'
        ? String(row.name).trim()
        : '';
    const rawArgs = typeof fn.arguments === 'string'
      ? fn.arguments
      : fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)
        ? fn.arguments as Record<string, unknown>
        : typeof row.arguments === 'string'
          ? String(row.arguments)
          : row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
            ? row.arguments as Record<string, unknown>
            : typeof row.input === 'string'
              ? { input: row.input }
              : row.input && typeof row.input === 'object' && !Array.isArray(row.input)
                ? row.input as Record<string, unknown>
                : null;
    const parsedArgs = readAssistantToolArguments(rawArgs);
    if (!name) throw new Error('[windsurf] assistant tool call missing name');
    if (!callId) throw new Error('[windsurf] assistant tool call missing call_id');
    const argsJson = args.stableStringify(parsedArgs);
    if (seenToolCallIds.has(callId)) throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
    seenToolCallIds.add(callId);
    toolCalls.push({ id: callId, type: 'function', function: { name, arguments: argsJson } });
  }

  const hasTopLevelToolCalls = toolCalls.length > 0;

  for (const item of rawContent) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
    if (type === 'text' || type === 'output_text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
      throw new Error('[windsurf] assistant candidate mixed content with embedded tool result block');
    }
    if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call') continue;
    if (hasTopLevelToolCalls) {
      throw new Error('[windsurf] assistant response mixed top-level tool_calls with content tool call');
    }
    const callId = typeof block.call_id === 'string'
      ? block.call_id.trim()
      : typeof block.id === 'string'
        ? block.id.trim()
        : '';
    const name = typeof block.name === 'string' ? block.name.trim() : '';
    if (!name) throw new Error('[windsurf] assistant tool call missing name');
    if (!callId) throw new Error('[windsurf] assistant tool call missing call_id');
    let parsedArgs: Record<string, unknown>;
    if (type === 'custom_tool_call') {
      if (typeof block.input === 'string') {
        parsedArgs = { input: block.input };
      } else if (block.input && typeof block.input === 'object' && !Array.isArray(block.input)) {
        parsedArgs = block.input as Record<string, unknown>;
      } else {
        parsedArgs = {};
      }
    } else if (type === 'function_call' && typeof block.arguments === 'string') {
      parsedArgs = readAssistantToolArguments(block.arguments);
    } else if (block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)) {
      parsedArgs = block.arguments as Record<string, unknown>;
    } else {
      throw new Error('[windsurf] assistant tool call arguments must be object');
    }
    const argsJson = args.stableStringify(parsedArgs);
    if (seenToolCallIds.has(callId)) throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
    seenToolCallIds.add(callId);
    toolCalls.push({ id: callId, type: 'function', function: { name, arguments: argsJson } });
  }

  let rawText = textParts.join('');
  if (/<\/?\s*(?:tool_call|function_call)\b/i.test(rawText)) {
    throw args.createError('[windsurf] legacy tool_call text protocol is not allowed in cascade assistant content', {
      code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
      status: 400,
      retryable: false,
    });
  }
  const rccHarvest = args.harvestRccToolCalls(rawText, args.rccTextTools || []);
  if (rccHarvest.toolCalls.length > 0) {
    if (toolCalls.length > 0) {
      throw args.createError('[windsurf] native trajectory tool call conflicts with RCC text tool call', {
        code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
        status: 400,
        retryable: false,
      });
    }
    for (const call of rccHarvest.toolCalls) toolCalls.push(call);
    rawText = rccHarvest.text;
  }
  const text = rawText;
  const reasoning_content = reasoningParts.join('');
  if (!text && toolCalls.length === 0 && !reasoning_content) {
    throw new Error('[windsurf] empty assistant completion');
  }

  return {
    role: 'assistant',
    content: text,
    ...(reasoning_content ? { reasoning_content } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export type WindsurfBridgeToolHistoryPairLike = {
  callId: string;
  name: string;
  arguments?: unknown;
  output: string;
  status?: string;
};

export function readBridgeToolHistoryPairs(body: Record<string, unknown>): WindsurfBridgeToolHistoryPairLike[] {
  const semantics = body.semantics && typeof body.semantics === 'object' && !Array.isArray(body.semantics) ? body.semantics as Record<string, unknown> : {};
  const responses = semantics.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses) ? semantics.responses as Record<string, unknown> : {};
  const context = responses.context && typeof responses.context === 'object' && !Array.isArray(responses.context) ? responses.context as Record<string, unknown> : {};
  const toolHistory = context.toolHistory && typeof context.toolHistory === 'object' && !Array.isArray(context.toolHistory) ? context.toolHistory as Record<string, unknown> : {};
  if (toolHistory.version !== 1 || !Array.isArray(toolHistory.pairs)) return [];
  return toolHistory.pairs.map((entry) => {
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    return {
      callId: typeof row.callId === 'string' ? row.callId.trim() : '',
      name: typeof row.name === 'string' ? row.name.trim() : '',
      arguments: row.arguments,
      output: typeof row.output === 'string' ? row.output : row.output == null ? '' : JSON.stringify(row.output),
      status: typeof row.status === 'string' ? row.status.trim() : undefined,
    };
  }).filter((pair) => pair.callId && pair.name);
}

export function appendBridgeToolHistoryToSemanticConversation(args: {
  semanticConversation: WindsurfSemanticTurnLike[];
  pairs: WindsurfBridgeToolHistoryPairLike[];
}): void {
  if (args.pairs.length === 0) return;
  const collectEquivalentCallIds = (raw: string): string[] => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return [];
    const out = new Set<string>([trimmed]);
    if (trimmed.startsWith('fc_')) {
      const stripped = trimmed.slice(3);
      if (stripped) out.add(stripped);
    } else {
      out.add(`fc_${trimmed}`);
    }
    return Array.from(out);
  };
  const existingToolCallIds = new Set<string>();
  const existingToolResultIds = new Set<string>();
  for (const turn of args.semanticConversation) {
    if (turn.type === 'assistant' && Array.isArray(turn.tool_calls)) {
      for (const call of turn.tool_calls) {
        for (const candidate of collectEquivalentCallIds(call.call_id)) {
          existingToolCallIds.add(candidate);
        }
      }
    }
    if (turn.type === 'function_call_output') {
      const row = turn as Record<string, unknown>;
      if (typeof row.call_id === 'string') {
        for (const candidate of collectEquivalentCallIds(row.call_id)) {
          existingToolResultIds.add(candidate);
        }
      }
    }
  }
  for (const pair of args.pairs) {
    if (!existingToolCallIds.has(pair.callId)) {
      args.semanticConversation.push({
        type: 'assistant',
        text: '',
        tool_calls: [{
          call_id: pair.callId,
          name: pair.name,
          arguments: pair.arguments && typeof pair.arguments === 'object' && !Array.isArray(pair.arguments) ? pair.arguments as Record<string, unknown> : {},
        }],
      });
      for (const candidate of collectEquivalentCallIds(pair.callId)) {
        existingToolCallIds.add(candidate);
      }
    }
    if (!existingToolResultIds.has(pair.callId)) {
      args.semanticConversation.push({ type: 'function_call_output', call_id: pair.callId, name: pair.name, output: pair.output, source: 'bridge_tool_history' });
      for (const candidate of collectEquivalentCallIds(pair.callId)) {
        existingToolResultIds.add(candidate);
      }
    }
  }
}

function extractNestedToolResultCallId(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const candidates = [block.tool_call_id, block.call_id, block.tool_use_id, block.id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return '';
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let sawStructuredBlock = false;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
      if (type === 'text' || type === 'output_text') {
        sawStructuredBlock = true;
        const text = typeof block.text === 'string' ? block.text : '';
        if (text) parts.push(text);
        continue;
      }
      if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output' || type === 'tool_message') {
        sawStructuredBlock = true;
        const nestedOutput = typeof block.output === 'string'
          ? block.output
          : block.output == null
            ? typeof block.content === 'string'
              ? block.content
              : block.content == null
                ? ''
                : JSON.stringify(block.content)
            : JSON.stringify(block.output);
        if (nestedOutput) parts.push(nestedOutput);
      }
    }
    if (sawStructuredBlock) return parts.join('');
  }
  return JSON.stringify(content);
}

export function parseCascadeToolResultTurn(args: {
  message: unknown;
  matchedCalls: Map<string, { name: string }>;
}): Extract<WindsurfSemanticTurnLike, { type: 'function_call_output' }> {
  const msg = args.message && typeof args.message === 'object' ? args.message as Record<string, unknown> : {};
  const callId = typeof msg.tool_call_id === 'string'
    ? msg.tool_call_id.trim()
    : typeof msg.id === 'string'
      ? msg.id.trim()
      : extractNestedToolResultCallId(msg.content);
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  const output = normalizeToolResultContent(msg.content);
  if (!callId || !args.matchedCalls.has(callId)) {
    throw new Error('[windsurf] orphan tool_result without matching assistant tool call');
  }
  const matched = args.matchedCalls.get(callId)!;
  const annotatedOutput = (
    matched.name === 'Read'
    && typeof output === 'string'
    && output
    && !/^\s*\d+\t/m.test(output)
    && ((/(?:file )?(?:content )?(?:unchanged|cached)/i.test(output) && output.length < 2000) || /truncated|截断|丢失/i.test(output.toLowerCase()))
  )
    ? `${output}\n\n[WindsurfAPI note: This Read result does not prove the full file body is available in the current conversation. If the task depends on full file contents, use Read with offset/limit or another content-bearing tool result before returning PASS.]`
    : output;
  return {
    type: 'function_call_output',
    call_id: callId,
    name: name || matched.name,
    output: annotatedOutput,
  };
}

function normalizeSemanticTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) parts.push(text);
    }
  }
  return parts.join('');
}

function readSemanticToolCallArguments(rawArgs: unknown): Record<string, unknown> {
  try {
    if (typeof rawArgs === 'string') {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      throw new Error('[windsurf] assistant tool call arguments must be valid json object');
    }
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs as Record<string, unknown>;
    throw new Error('[windsurf] assistant tool call arguments must be valid json object');
  } catch {
    throw new Error('[windsurf] assistant tool call arguments must be valid json object');
  }
}

export function parseCascadeSemanticRoundtrip(args: {
  messages: unknown;
  parseToolResultTurn: (message: unknown, matchedCalls: Map<string, { name: string }>) => Extract<WindsurfSemanticTurnLike, { type: 'function_call_output' }>;
}): WindsurfSemanticTurnLike[] {
  if (!Array.isArray(args.messages)) return [];
  const out: WindsurfSemanticTurnLike[] = [];
  const matchedCalls = new Map<string, { name: string }>();
  const completedToolCallIds = new Set<string>();

  for (const item of args.messages) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';

    if (role === 'user') {
      const text = normalizeSemanticTextContent(msg.content);
      out.push({ type: 'user', text });
      continue;
    }

    if (role === 'assistant') {
      const toolCallsRaw = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
      const textParts: string[] = [];
      if (typeof msg.content === 'string') textParts.push(msg.content);
      const normalizedCalls: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> = [];
      const seenHistoryToolCallIds = new Set<string>();

      for (const entry of toolCallsRaw) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
        const callId = typeof row.call_id === 'string' ? row.call_id.trim() : typeof row.id === 'string' ? String(row.id).trim() : '';
        const name = typeof fn.name === 'string' ? fn.name.trim() : typeof row.name === 'string' ? String(row.name).trim() : '';
        const rawArgs = typeof fn.arguments === 'string'
          ? fn.arguments
          : fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)
            ? fn.arguments as Record<string, unknown>
            : typeof row.arguments === 'string'
              ? String(row.arguments)
              : row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
                ? row.arguments as Record<string, unknown>
                : typeof row.input === 'string'
                  ? { input: row.input }
                  : row.input && typeof row.input === 'object' && !Array.isArray(row.input)
                    ? row.input as Record<string, unknown>
                    : null;
        const parsedArgs = readSemanticToolCallArguments(rawArgs);
        if (!name) throw new Error('[windsurf] assistant tool call missing name');
        if (!callId) throw new Error('[windsurf] assistant tool call missing call_id');
        if (seenHistoryToolCallIds.has(callId)) throw new Error('[windsurf] duplicate assistant tool call id in history');
        seenHistoryToolCallIds.add(callId);
        normalizedCalls.push({ call_id: callId, name, arguments: parsedArgs });
      }

      if (contentBlocks.length > 0) {
        const hasChatToolCalls = normalizedCalls.length > 0;
        for (const blockEntry of contentBlocks) {
          if (!blockEntry || typeof blockEntry !== 'object') continue;
          const block = blockEntry as Record<string, unknown>;
          const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
          if (type === 'output_text' || type === 'text') {
            const blockText = typeof block.text === 'string' ? block.text : '';
            if (blockText) textParts.push(blockText);
            continue;
          }
          if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call' && type !== 'tool_use') continue;
          const callId = typeof block.call_id === 'string'
            ? block.call_id.trim()
            : typeof block.id === 'string'
              ? block.id.trim()
              : '';
          const name = typeof block.name === 'string' ? block.name.trim() : '';
          const rawArgs = typeof block.arguments === 'string'
            ? block.arguments
            : type === 'custom_tool_call' && typeof block.input === 'string'
              ? JSON.stringify({ input: block.input })
              : type === 'custom_tool_call' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                ? block.input
                : type === 'tool_use' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                  ? block.input
                  : block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)
                    ? block.arguments
                    : '{}';
          const parsedArgs = readSemanticToolCallArguments(rawArgs);
          if (!name) throw new Error('[windsurf] assistant tool call missing name');
          if (!callId) throw new Error('[windsurf] assistant tool call missing call_id');
          if (hasChatToolCalls) {
            if (seenHistoryToolCallIds.has(callId)) throw new Error('[windsurf] duplicate assistant tool call id in history');
            throw new Error('[windsurf] assistant history mixed chat tool_calls with content tool call');
          }
          if (seenHistoryToolCallIds.has(callId)) throw new Error('[windsurf] duplicate assistant tool call id in history');
          seenHistoryToolCallIds.add(callId);
          normalizedCalls.push({ call_id: callId, name, arguments: parsedArgs });
        }
      }

      const text = textParts.join('');
      if (!text && normalizedCalls.length === 0) throw new Error('[windsurf] empty assistant completion');
      for (const call of normalizedCalls) matchedCalls.set(call.call_id, { name: call.name });
      out.push({
        type: 'assistant',
        text,
        ...(normalizedCalls.length > 0 ? { tool_calls: normalizedCalls } : {}),
      });
      continue;
    }

    if (role === 'tool') {
      const parsedToolResult = args.parseToolResultTurn(msg, matchedCalls);
      if (completedToolCallIds.has(parsedToolResult.call_id)) {
        throw new Error('[windsurf] duplicate tool_result for completed tool call');
      }
      out.push(parsedToolResult);
      completedToolCallIds.add(parsedToolResult.call_id);
    }
  }

  return out;
}
