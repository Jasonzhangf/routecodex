import { requireCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';

type NativeRouterHotpathPolicyModule = {
  failNativeRequired?: <T = never>(capability: string, reason?: string) => T;
};

type NativeRouterHotpathModule = {
  loadNativeRouterHotpathBindingForInternalUse?: () => Record<string, unknown> | null;
};

let cachedNativePolicy: NativeRouterHotpathPolicyModule | null = null;
let cachedNativeHotpath: NativeRouterHotpathModule | null = null;

function failNativeRequired<T = never>(capability: string, reason?: string): T {
  if (!cachedNativePolicy) {
    cachedNativePolicy = requireCoreDist<NativeRouterHotpathPolicyModule>(
      'router/virtual-router/engine-selection/native-router-hotpath-policy'
    );
  }
  const fn = cachedNativePolicy.failNativeRequired;
  if (typeof fn !== 'function') {
    throw new Error(`[windsurf-native] native policy unavailable: ${capability}${reason ? `: ${reason}` : ''}`);
  }
  return fn<T>(capability, reason);
}

function loadNativeRouterHotpathBindingForInternalUse(): Record<string, unknown> | null {
  if (!cachedNativeHotpath) {
    cachedNativeHotpath = requireCoreDist<NativeRouterHotpathModule>(
      'router/virtual-router/engine-selection/native-router-hotpath'
    );
  }
  const fn = cachedNativeHotpath.loadNativeRouterHotpathBindingForInternalUse;
  if (typeof fn !== 'function') {
    return null;
  }
  return fn();
}

type NativeRccProjectionInput = {
  semanticConversation: unknown[];
  rccTextTools: unknown[];
};

type NativeRccContextOutput = {
  context: string;
};

type NativeRccMarkerContractOutput = {
  ok: boolean;
  missing?: string[];
};

type NativeRccGuidanceOutput = {
  guidance: string;
};

type NativeRccPendingReminderInput = NativeRccProjectionInput & {
  windsurfNativeToolNames: string[];
};

type NativeRccPendingReminderOutput = {
  reminder: string;
};

type NativeCascadePromptInput = NativeRccProjectionInput & {
  messages: unknown[];
  rccGuidance: string;
  rccPendingReminder: string;
  maxHistoryBytes: number;
  windsurfNativeToolNames: string[];
};

type NativeCascadePromptOutput = {
  prompt: string;
};

type NativeRccHarvestInput = {
  text: string;
  rccTextTools: unknown[];
};

type NativeRccHarvestOutput = {
  text: string;
  toolCalls: unknown[];
  error?: {
    message?: string;
    code?: string;
    status?: number;
    retryable?: boolean;
  };
};

type NativeWindsurfSignatureInput = {
  kind: string;
  payload: unknown;
};

type NativeWindsurfSignatureOutput = {
  signature: string;
};

type NativeWindsurfPairingInput = {
  rawCall: unknown;
  completedCallIds: string[];
  completedSignatures: string[];
};

type NativeWindsurfPairingOutput = {
  action: string;
  reason: string;
  strategy: string;
};

type NativeWindsurfAdditionalStepPayloadsInput = {
  semanticConversation: unknown[];
  nativeToolNames: string[];
};

type NativeWindsurfAdditionalStepPayloadsOutput = {
  steps: Array<{ kind: string; payload: Record<string, unknown> }>;
};

type NativeParseCascadeAssistantTurnInput = {
  candidate: unknown;
  rccTextTools: unknown[];
};

type NativeParseCascadeAssistantTurnOutput = {
  assistant: Record<string, unknown>;
};

type NativeParseCascadeToolResultTurnInput = {
  message: unknown;
  matchedCalls: Record<string, { name: string }>;
};

type NativeParseCascadeToolResultTurnOutput = {
  toolResult: Record<string, unknown>;
};

type NativeParseCascadeSemanticRoundtripInput = {
  messages: unknown[];
};

type NativeParseCascadeSemanticRoundtripOutput = {
  semanticConversation: unknown[];
};

function readNativeFunction(name: string): ((inputJson: string) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (inputJson: string) => unknown) : null;
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return failNativeRequired<string>('windsurfRccToolHistoryProjectionJson', 'json stringify failed');
  }
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return failNativeRequired<Record<string, unknown>>('windsurfRccToolHistoryProjectionJson', 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<Record<string, unknown>>('windsurfRccToolHistoryProjectionJson', `json parse failed: ${reason}`);
  }
}

export function buildWindsurfRccToolResultContextWithNative(input: NativeRccProjectionInput): NativeRccContextOutput {
  const capability = 'buildWindsurfRccToolResultContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeRccContextOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeRccContextOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.context !== 'string') return failNativeRequired<NativeRccContextOutput>(capability, 'invalid payload');
    return { context: parsed.context };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeRccContextOutput>(capability, reason);
  }
}

export function assertWindsurfRccToolResultMarkerContractWithNative(input: NativeRccProjectionInput): NativeRccMarkerContractOutput {
  const capability = 'assertWindsurfRccToolResultMarkerContractJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeRccMarkerContractOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeRccMarkerContractOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.ok !== 'boolean') return failNativeRequired<NativeRccMarkerContractOutput>(capability, 'invalid payload');
    const missing = Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === 'string') : undefined;
    return missing && missing.length > 0 ? { ok: parsed.ok, missing } : { ok: parsed.ok };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeRccMarkerContractOutput>(capability, reason);
  }
}

export function buildWindsurfCascadePromptTextWithNative(input: NativeCascadePromptInput): NativeCascadePromptOutput {
  const capability = 'buildWindsurfCascadePromptTextJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeCascadePromptOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeCascadePromptOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.prompt !== 'string') return failNativeRequired<NativeCascadePromptOutput>(capability, 'invalid payload');
    return { prompt: parsed.prompt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeCascadePromptOutput>(capability, reason);
  }
}

export function buildWindsurfRccToolGuidanceWithNative(input: NativeRccProjectionInput): NativeRccGuidanceOutput {
  const capability = 'buildWindsurfRccToolGuidanceJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeRccGuidanceOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeRccGuidanceOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.guidance !== 'string') return failNativeRequired<NativeRccGuidanceOutput>(capability, 'invalid payload');
    return { guidance: parsed.guidance };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeRccGuidanceOutput>(capability, reason);
  }
}

export function buildWindsurfRccPendingToolReminderWithNative(input: NativeRccPendingReminderInput): NativeRccPendingReminderOutput {
  const capability = 'buildWindsurfRccPendingToolReminderJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeRccPendingReminderOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeRccPendingReminderOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.reminder !== 'string') return failNativeRequired<NativeRccPendingReminderOutput>(capability, 'invalid payload');
    return { reminder: parsed.reminder };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeRccPendingReminderOutput>(capability, reason);
  }
}

export function harvestWindsurfRccToolCallsWithNative(input: NativeRccHarvestInput): NativeRccHarvestOutput {
  const capability = 'harvestWindsurfRccToolCallsJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeRccHarvestOutput>(capability);
  try {
    const raw = fn(stringifyInput(input));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeRccHarvestOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.toolCalls)) {
      return failNativeRequired<NativeRccHarvestOutput>(capability, 'invalid payload');
    }
    const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? parsed.error as NativeRccHarvestOutput['error']
      : undefined;
    return error ? { text: parsed.text, toolCalls: parsed.toolCalls, error } : { text: parsed.text, toolCalls: parsed.toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeRccHarvestOutput>(capability, reason);
  }
}

export function buildWindsurfNativeToolSignatureWithNative(input: NativeWindsurfSignatureInput): NativeWindsurfSignatureOutput {
  const capability = 'buildWindsurfNativeToolSignatureJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeWindsurfSignatureOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeWindsurfSignatureOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.signature !== 'string') return failNativeRequired<NativeWindsurfSignatureOutput>(capability, 'invalid payload');
    return { signature: parsed.signature };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeWindsurfSignatureOutput>(capability, reason);
  }
}

export function decideWindsurfCompletedNativeToolCallPairingWithNative(input: NativeWindsurfPairingInput): NativeWindsurfPairingOutput {
  const capability = 'decideWindsurfCompletedNativeToolCallPairingJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeWindsurfPairingOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeWindsurfPairingOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.action !== 'string' || typeof parsed.reason !== 'string' || typeof parsed.strategy !== 'string') {
      return failNativeRequired<NativeWindsurfPairingOutput>(capability, 'invalid payload');
    }
    return { action: parsed.action, reason: parsed.reason, strategy: parsed.strategy };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeWindsurfPairingOutput>(capability, reason);
  }
}

export function buildWindsurfNativeAdditionalStepPayloadsWithNative(input: NativeWindsurfAdditionalStepPayloadsInput): NativeWindsurfAdditionalStepPayloadsOutput {
  const capability = 'buildWindsurfNativeAdditionalStepPayloadsJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeWindsurfAdditionalStepPayloadsOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeWindsurfAdditionalStepPayloadsOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.steps)) return failNativeRequired<NativeWindsurfAdditionalStepPayloadsOutput>(capability, 'invalid payload');
    const steps = parsed.steps.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.kind !== 'string') return [];
      const payload = row.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      return [{ kind: row.kind, payload: payload as Record<string, unknown> }];
    });
    return { steps };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeWindsurfAdditionalStepPayloadsOutput>(capability, reason);
  }
}

export function parseCascadeAssistantTurnWithNative(input: NativeParseCascadeAssistantTurnInput): NativeParseCascadeAssistantTurnOutput {
  const capability = 'parseCascadeAssistantTurnJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeParseCascadeAssistantTurnOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeParseCascadeAssistantTurnOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.assistant || typeof parsed.assistant !== 'object' || Array.isArray(parsed.assistant)) {
      return failNativeRequired<NativeParseCascadeAssistantTurnOutput>(capability, 'invalid payload');
    }
    return { assistant: parsed.assistant as Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeParseCascadeAssistantTurnOutput>(capability, reason);
  }
}

export function parseCascadeToolResultTurnWithNative(input: NativeParseCascadeToolResultTurnInput): NativeParseCascadeToolResultTurnOutput {
  const capability = 'parseCascadeToolResultTurnJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeParseCascadeToolResultTurnOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as unknown as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeParseCascadeToolResultTurnOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.toolResult || typeof parsed.toolResult !== 'object' || Array.isArray(parsed.toolResult)) {
      return failNativeRequired<NativeParseCascadeToolResultTurnOutput>(capability, 'invalid payload');
    }
    return { toolResult: parsed.toolResult as Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeParseCascadeToolResultTurnOutput>(capability, reason);
  }
}

export function parseCascadeSemanticRoundtripWithNative(input: NativeParseCascadeSemanticRoundtripInput): NativeParseCascadeSemanticRoundtripOutput {
  const capability = 'parseCascadeSemanticRoundtripJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<NativeParseCascadeSemanticRoundtripOutput>(capability);
  try {
    const raw = fn(stringifyInput(input as Record<string, unknown>));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<NativeParseCascadeSemanticRoundtripOutput>(capability, 'empty result');
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.semanticConversation)) {
      return failNativeRequired<NativeParseCascadeSemanticRoundtripOutput>(capability, 'invalid payload');
    }
    return { semanticConversation: parsed.semanticConversation };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<NativeParseCascadeSemanticRoundtripOutput>(capability, reason);
  }
}
