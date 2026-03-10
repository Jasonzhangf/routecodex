import type { ChatToolDefinition } from '../hub/types/chat-envelope.js';
import type { BridgeToolDefinition } from '../types/bridge-message-types.js';
import {
  bridgeToolToChatDefinitionWithNative,
  chatToolToBridgeDefinitionWithNative,
  mapBridgeToolsToChatWithNative,
  mapChatToolsToBridgeWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

// Placeholder for strict tool/arguments mapping shared helper.
// Phase 2 will move normalization & schema-aware shaping here.
export interface ToolCallFunction {
  name: string;
  arguments: string; // always JSON string
}

export interface ToolCallItem {
  id?: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface BridgeToolMapOptions {
  sanitizeName?: (name: string) => string | undefined;
}

export function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}); } catch { return String(args); }
}

function assertToolMappingNativeAvailable(): void {
  if (
    typeof bridgeToolToChatDefinitionWithNative !== 'function' ||
    typeof chatToolToBridgeDefinitionWithNative !== 'function' ||
    typeof mapBridgeToolsToChatWithNative !== 'function' ||
    typeof mapChatToolsToBridgeWithNative !== 'function'
  ) {
    throw new Error('[tool-mapping] native bindings unavailable');
  }
}

function resolveSanitizeMode(options?: BridgeToolMapOptions, fallback: string = 'responses'): string {
  const probe = options?.sanitizeName?.('shell_command') ?? options?.sanitizeName?.('Bash');
  if (typeof probe === 'string' && probe === 'shell_command') {
    return 'anthropic';
  }
  if (typeof probe === 'string' && probe === 'Bash') {
    return 'anthropic_denormalize';
  }
  return fallback;
}

export function bridgeToolToChatDefinition(
  rawTool: BridgeToolDefinition | Record<string, unknown> | null | undefined,
  options?: BridgeToolMapOptions
): ChatToolDefinition | null {
  if (!rawTool || typeof rawTool !== 'object') {
    return null;
  }
  assertToolMappingNativeAvailable();
  const sanitizeMode = resolveSanitizeMode(options, 'responses');
  const mapped = bridgeToolToChatDefinitionWithNative(rawTool as Record<string, unknown>, { sanitizeMode });
  return (mapped as ChatToolDefinition | null) ?? null;
}

export function mapBridgeToolsToChat(
  rawTools: unknown,
  options?: BridgeToolMapOptions
): ChatToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  assertToolMappingNativeAvailable();
  const sanitizeMode = resolveSanitizeMode(options, 'responses');
  const mapped = mapBridgeToolsToChatWithNative(rawTools, { sanitizeMode });
  return mapped.length ? (mapped as ChatToolDefinition[]) : undefined;
}

export function chatToolToBridgeDefinition(
  rawTool: ChatToolDefinition | Record<string, unknown> | null | undefined,
  options?: BridgeToolMapOptions
): BridgeToolDefinition | null {
  if (!rawTool || typeof rawTool !== 'object') {
    return null;
  }
  assertToolMappingNativeAvailable();
  const sanitizeMode = resolveSanitizeMode(options, 'responses');
  const mapped = chatToolToBridgeDefinitionWithNative(rawTool as Record<string, unknown>, { sanitizeMode });
  return (mapped as BridgeToolDefinition | null) ?? null;
}

export function mapChatToolsToBridge(
  rawTools: unknown,
  options?: BridgeToolMapOptions
): BridgeToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  assertToolMappingNativeAvailable();
  const sanitizeMode = resolveSanitizeMode(options, 'responses');
  const mapped = mapChatToolsToBridgeWithNative(rawTools, { sanitizeMode });
  return mapped.length ? (mapped as BridgeToolDefinition[]) : undefined;
}
