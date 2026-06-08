import {
  failNativeRequired,
  isNativeDisabledByEnv,
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function toNapiExportName(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function readNativeFunction(
  name: string,
): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<
    string,
    unknown
  > | null;
  const fn = binding?.[name] ?? binding?.[toNapiExportName(name)];
  return typeof fn === 'function'
    ? (fn as (...args: unknown[]) => unknown)
    : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function invokeRecordCapability(
  capability: string,
  args: unknown[],
): Record<string, unknown> {
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) return fail('json stringify failed');
    encodedArgs.push(encoded);
  }
  try {
    const raw = fn(...encodedArgs);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error: unknown) {
    const reason =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeVoidCapability(capability: string, args: unknown[]): void {
  const fail = (reason?: string) => failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) return fail('json stringify failed');
    encodedArgs.push(encoded);
  }
  try {
    fn(...encodedArgs);
  } catch (error: unknown) {
    const reason =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(reason);
  }
}

export function normalizeResponsePayloadWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('normalizeResponsePayloadJson', [
    payload,
    config ?? {},
  ]);
}

export function validateResponsePayloadWithNative(
  payload: Record<string, unknown>,
): void {
  invokeVoidCapability('validateResponsePayloadJson', [payload]);
}

export function applyRequestRulesWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyRequestRulesJson', [payload, config ?? {}]);
}

export function applyFieldMappingsWithNative(
  payload: Record<string, unknown>,
  mappings: unknown[],
): Record<string, unknown> {
  return invokeRecordCapability('applyFieldMappingsJson', [
    payload,
    Array.isArray(mappings) ? mappings : [],
  ]);
}

export function sanitizeToolSchemaGlmShellWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('sanitizeToolSchemaGlmShellJson', [payload]);
}




export function applyResponseBlacklistWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyResponseBlacklistJson', [
    payload,
    config ?? {},
  ]);
}

export function normalizeToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('normalizeToolCallIdsJson', [payload]);
}

export function enforceLmstudioResponsesFcToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('enforceLmstudioResponsesFcToolCallIdsJson', [
    payload,
  ]);
}

export function applyAnthropicClaudeCodeUserIdWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyAnthropicClaudeCodeUserIdJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function applyGeminiWebSearchRequestCompatWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyGeminiWebSearchRequestCompatJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function applyLmstudioResponsesInputStringifyWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyLmstudioResponsesInputStringifyJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function applyToolTextRequestGuidanceWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyToolTextRequestGuidanceJson', [
    payload,
    config ?? {},
  ]);
}

export function harvestToolCallsFromTextWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('harvestToolCallsFromTextJson', [
    payload,
    options ?? {},
  ]);
}

export function applyUniversalShapeRequestFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyUniversalShapeRequestFilterJson', [
    payload,
    config ?? {},
  ]);
}

export function applyUniversalShapeResponseFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyUniversalShapeResponseFilterJson', [
    payload,
    config ?? {},
    adapterContext ?? {},
  ]);
}

export function buildOpenAIChatFromAnthropicWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('buildOpenaiChatFromAnthropicJson', [
    payload,
    options ?? {},
  ]);
}

export function buildAnthropicFromOpenAIChatWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('buildAnthropicFromOpenaiChatJson', [
    payload,
    options ?? {},
  ]);
}

export function runOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runOpenaiOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runOpenaiOpenaiResponseCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runResponsesOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runResponsesOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runResponsesOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runResponsesOpenaiResponseCodecJson', [
    payload,
    context,
  ]);
}

export function runGeminiOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runGeminiOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiOpenaiResponseCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runGeminiFromOpenAIChatCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiFromOpenaiChatCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function stripFunctionNamespaceWithNative(raw: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `stripFunctionNamespace: ${reason}` : 'stripFunctionNamespace failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('strip_function_namespace_json');
  if (!fn) return fail();
  try {
    const result = fn(raw);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`stripFunctionNamespace: ${reason}`);
  }
}

export function toCanonicalToolNameWithNative(raw: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `toCanonicalToolName: ${reason}` : 'toCanonicalToolName failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('to_canonical_tool_name_json');
  if (!fn) return fail();
  try {
    const result = fn(raw);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`toCanonicalToolName: ${reason}`);
  }
}

export function toCompactToolNameWithNative(raw: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `toCompactToolName: ${reason}` : 'toCompactToolName failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('to_compact_tool_name_json');
  if (!fn) return fail();
  try {
    const result = fn(raw);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`toCompactToolName: ${reason}`);
  }
}

export function resolveToolFamilyWithNative(raw: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `resolveToolFamily: ${reason}` : 'resolveToolFamily failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('resolve_tool_family_json');
  if (!fn) return fail();
  try {
    const result = fn(raw);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`resolveToolFamily: ${reason}`);
  }
}

export function buildNamespaceAliasWithNative(namespace: string, rawName: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `buildNamespaceAlias: ${reason}` : 'buildNamespaceAlias failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('build_namespace_alias_json');
  if (!fn) return fail();
  try {
    const result = fn(namespace, rawName);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`buildNamespaceAlias: ${reason}`);
  }
}

export function buildNamespaceLookupKeyWithNative(namespace: string, rawName: string): string {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `buildNamespaceLookupKey: ${reason}` : 'buildNamespaceLookupKey failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('build_namespace_lookup_key_json');
  if (!fn) return fail();
  try {
    const result = fn(namespace, rawName);
    if (typeof result !== 'string') return fail('invalid result type');
    return result;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`buildNamespaceLookupKey: ${reason}`);
  }
}

export function readSchemaWithNative(entry: unknown): unknown {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `readSchema: ${reason}` : 'readSchema failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('read_schema_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify(entry));
    return JSON.parse(result as string);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`readSchema: ${reason}`);
  }
}

export function shouldLogClientRemapDebugWithNative(payload: unknown): boolean {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `shouldLogClientRemapDebug: ${reason}` : 'shouldLogClientRemapDebug failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('should_log_client_remap_debug_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify(payload));
    return JSON.parse(result as string);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`shouldLogClientRemapDebug: ${reason}`);
  }
}

export function extractDeclaredToolNamesWithNative(tools: unknown[]): string[] {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `extractDeclaredToolNames: ${reason}` : 'extractDeclaredToolNames failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('extract_declared_tool_names_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify(tools));
    return JSON.parse(result as string);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`extractDeclaredToolNames: ${reason}`);
  }
}

export interface ClientToolMismatchError {
  code: string;
  statusCode: number;
  retryable: boolean;
  message: string;
  details: {
    unknownToolNames: string[];
    declaredToolNames: string[];
    protocol: string;
    requestId: string;
  };
}

export function assertNoUnknownToolNamesWithNative(args: {
  requestId: string;
  clientProtocol: string;
  unknownNames: string[];
  clientToolsRaw?: unknown[];
}): void {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `assertNoUnknownToolNames: ${reason}` : 'assertNoUnknownToolNames failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('assert_no_unknown_tool_names_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify(args));
    if (result === 'null') {
      return; // No unknown names, success
    }
    const error: ClientToolMismatchError = JSON.parse(result as string);
    const err = new Error(error.message) as Error & { code?: string; statusCode?: number; retryable?: boolean; details?: Record<string, unknown> };
    err.code = error.code;
    err.statusCode = error.statusCode;
    err.retryable = error.retryable;
    err.details = error.details as Record<string, unknown>;
    throw err;
  } catch (error: unknown) {
    if ((error as any).code === 'NATIVE_REQUIRED') throw error;
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`assertNoUnknownToolNames: ${reason}`);
  }
}

export function extractClientToolIndexWithNative(clientToolsRaw?: unknown[]): {
  byExactLower: Map<string, unknown>;
  byStrippedLower: Map<string, unknown>;
  byCanonicalLower: Map<string, unknown>;
  byCompactLower: Map<string, unknown>;
  byFamily: Map<string, unknown>;
  byNamespaceName: Map<string, unknown>;
} {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `extractClientToolIndex: ${reason}` : 'extractClientToolIndex failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('extract_client_tool_index_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify({ client_tools_raw: clientToolsRaw }));
    const parsed = JSON.parse(result as string);
    // Convert to TS Maps
    return {
      byExactLower: new Map(Object.entries(parsed.by_exact_lower)),
      byStrippedLower: new Map(Object.entries(parsed.by_stripped_lower)),
      byCanonicalLower: new Map(Object.entries(parsed.by_canonical_lower)),
      byCompactLower: new Map(Object.entries(parsed.by_compact_lower)),
      byFamily: new Map(Object.entries(parsed.by_family)),
      byNamespaceName: new Map(Object.entries(parsed.by_namespace_name)),
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`extractClientToolIndex: ${reason}`);
  }
}

export function resolveClientToolFromIndexWithNative(index: {
  byExactLower: Map<string, unknown>;
  byStrippedLower: Map<string, unknown>;
  byCanonicalLower: Map<string, unknown>;
  byCompactLower: Map<string, unknown>;
  byFamily: Map<string, unknown>;
  byNamespaceName: Map<string, unknown>;
}, rawName: string, namespace?: string): unknown {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `resolveClientToolFromIndex: ${reason}` : 'resolveClientToolFromIndex failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('resolve_client_tool_from_index_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify({
      index: {
        by_exact_lower: Object.fromEntries(index.byExactLower),
        by_stripped_lower: Object.fromEntries(index.byStrippedLower),
        by_canonical_lower: Object.fromEntries(index.byCanonicalLower),
        by_compact_lower: Object.fromEntries(index.byCompactLower),
        by_family: Object.fromEntries(index.byFamily),
        by_namespace_name: Object.fromEntries(index.byNamespaceName),
      },
      raw_name: rawName,
      namespace: namespace,
    }));
    if (result === 'null') return undefined;
    return JSON.parse(result as string);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`resolveClientToolFromIndex: ${reason}`);
  }
}

export interface RemapChatResult {
  payload: unknown;
  unknownNames: string[];
}

export function remapChatToolCallsWithNative(payload: unknown, clientToolsRaw?: unknown[]): RemapChatResult {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `remapChatToolCalls: ${reason}` : 'remapChatToolCalls failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('remap_chat_tool_calls_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify({ payload, client_tools_raw: clientToolsRaw }));
    const parsed = JSON.parse(result as string);
    return {
      payload: parsed.payload,
      unknownNames: parsed.unknown_names,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`remapChatToolCalls: ${reason}`);
  }
}

export function remapResponsesToolCallsWithNative(payload: unknown, clientToolsRaw?: unknown[]): RemapChatResult {
  const fail = (reason?: string) => {
    const err = new Error(reason ? `remapResponsesToolCalls: ${reason}` : 'remapResponsesToolCalls failed');
    (err as any).code = 'NATIVE_REQUIRED';
    throw err;
  };
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction('remap_responses_tool_calls_json');
  if (!fn) return fail();
  try {
    const result = fn(JSON.stringify({ payload, client_tools_raw: clientToolsRaw }));
    const parsed = JSON.parse(result as string);
    return {
      payload: parsed.payload,
      unknownNames: parsed.unknown_names,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`remapResponsesToolCalls: ${reason}`);
  }
}
