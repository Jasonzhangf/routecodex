import type { ChatToolDefinition } from '../hub/types/chat-envelope.js';
import type { BridgeToolDefinition } from '../types/bridge-message-types.js';
import {
  flattenChatToolsForFunctionCallingWithNative,
  mapBridgeToolsToChatWithNative,
  mapChatToolsToBridgeWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

interface BridgeToolMapOptions {
  sanitizeName?: (name: string) => string | undefined;
}

function assertToolMappingNativeAvailable(): void {
  if (
    typeof flattenChatToolsForFunctionCallingWithNative !== 'function' ||
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

export function flattenChatToolsForFunctionCalling(
  rawTools: unknown,
  options?: BridgeToolMapOptions
): ChatToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  assertToolMappingNativeAvailable();
  const sanitizeMode = resolveSanitizeMode(options, 'responses');
  const mapped = flattenChatToolsForFunctionCallingWithNative(rawTools, { sanitizeMode });
  return mapped.length ? (mapped as ChatToolDefinition[]) : undefined;
}
