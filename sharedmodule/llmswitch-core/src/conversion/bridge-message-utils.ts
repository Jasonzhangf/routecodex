import {
  buildBridgeHistoryWithNative,
  coerceBridgeRoleWithNative,
  convertBridgeInputToChatMessagesWithNative,
  ensureMessagesArrayWithNative,
  serializeToolArgumentsWithNative,
  serializeToolOutputWithNative
} from '../native/router-hotpath/native-hub-bridge-action-semantics.js';

type BridgeContentPart = {
  type: string;
  text?: string;
  content?: unknown;
};

export type BridgeInputItem = {
  type: string;
  role?: string;
  content?: Array<BridgeContentPart> | null;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  output?: unknown;
  function?: { name?: string; arguments?: unknown };
  message?: { role?: string; content?: Array<BridgeContentPart> };
  id?: string;
  tool_call_id?: string;
  tool_use_id?: string;
  text?: string;
};

export interface BridgeInputBuildOptions {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>> | undefined;
  allowDanglingToolCalls?: boolean | undefined;
}

export interface BridgeInputBuildResult {
  input: BridgeInputItem[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

function assertBridgeMessageUtilsNativeAvailable(): void {
  if (
    typeof buildBridgeHistoryWithNative !== 'function' ||
    typeof convertBridgeInputToChatMessagesWithNative !== 'function' ||
    typeof coerceBridgeRoleWithNative !== 'function' ||
    typeof serializeToolArgumentsWithNative !== 'function' ||
    typeof serializeToolOutputWithNative !== 'function' ||
    typeof ensureMessagesArrayWithNative !== 'function'
  ) {
    throw new Error('[bridge-message-utils] native bindings unavailable');
  }
}

export function coerceBridgeRole(role: unknown): string {
  assertBridgeMessageUtilsNativeAvailable();
  return coerceBridgeRoleWithNative(role);
}

export function serializeToolArguments(argsStringOrObj: unknown, _functionName: string | undefined, _tools: unknown): string {
  assertBridgeMessageUtilsNativeAvailable();
  return serializeToolArgumentsWithNative({ args: argsStringOrObj });
}

export function serializeToolOutput(entry: BridgeInputItem): string | null {
  assertBridgeMessageUtilsNativeAvailable();
  return serializeToolOutputWithNative({ output: entry?.output });
}

export function convertMessagesToBridgeInput(options: BridgeInputBuildOptions): BridgeInputBuildResult {
  assertBridgeMessageUtilsNativeAvailable();
  const { messages, tools, allowDanglingToolCalls } = options;
  const native = buildBridgeHistoryWithNative({
    messages,
    tools,
    allowPendingTerminalToolCall: allowDanglingToolCalls === true
  });
  return native as BridgeInputBuildResult;
}

export interface BridgeInputToChatOptions {
  input?: BridgeInputItem[];
  tools?: Array<Record<string, unknown>>;
  normalizeFunctionName?: ((raw: unknown) => string | undefined) | 'default' | 'responses';
  toolResultFallbackText?: string;
  allowDanglingToolCalls?: boolean;
  allowOrphanToolResult?: boolean;
}

export function convertBridgeInputToChatMessages(options: BridgeInputToChatOptions): Array<Record<string, unknown>> {
  assertBridgeMessageUtilsNativeAvailable();
  const { input, tools, normalizeFunctionName, toolResultFallbackText, allowDanglingToolCalls, allowOrphanToolResult } = options;
  const output = convertBridgeInputToChatMessagesWithNative({
    input: Array.isArray(input) ? input : [],
    tools,
    toolResultFallbackText,
    normalizeFunctionName: typeof normalizeFunctionName === 'string' ? normalizeFunctionName : undefined,
    allowPendingTerminalToolCall: allowDanglingToolCalls === true,
    allowOrphanToolResult: allowOrphanToolResult === true
  });
  return output.messages;
}

export function ensureMessagesArray(state: any): Array<Record<string, unknown>> {
  assertBridgeMessageUtilsNativeAvailable();
  const output = ensureMessagesArrayWithNative({ state });
  return output.messages;
}
