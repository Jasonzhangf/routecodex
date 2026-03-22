import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseArray,
  parseJson,
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

function parseToolCallLiteArray(
  raw: string
): Array<{ id?: string; name: string; args: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ id?: string; name: string; args: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.args !== 'string') {
      return null;
    }
    const id = typeof row.id === 'string' && row.id.trim().length ? row.id : undefined;
    out.push({ id, name: row.name, args: row.args });
  }
  return out;
}

function parseReasoningItems(raw: string): Array<{ type: 'reasoning'; content: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ type: 'reasoning'; content: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (row.type !== 'reasoning' || typeof row.content !== 'string') {
      return null;
    }
    out.push({ type: 'reasoning', content: row.content });
  }
  return out;
}

function parseToolCallResult(raw: string): Array<{ id?: string; name: string; args: string }> | null {
  if (!raw || raw === 'null') {
    return null;
  }
  return parseToolCallLiteArray(raw);
}

function callTextMarkupExtractor(
  capability: string,
  payload: unknown
): Array<{ id?: string; name: string; args: string }> | null {
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ id?: string; name: string; args: string }> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    const parsed = parseToolCallResult(raw);
    return parsed ?? null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractJsonToolCallsFromTextWithNative(
  text: string,
  options?: Record<string, unknown>
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractJsonToolCallsFromTextJson', {
    text: String(text ?? ''),
    options: options ?? null
  });
}

export function extractXMLToolCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractXmlToolCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractSimpleXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractSimpleXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractParameterXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractParameterXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractInvokeToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractInvokeToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractToolNamespaceXmlBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractToolNamespaceXmlBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractApplyPatchCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractApplyPatchCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractBareExecCommandFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractBareExecCommandFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExecuteBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExecuteBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExploredListDirectoryCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExploredListDirectoryCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractQwenToolCallTokensFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractQwenToolCallTokensFromTextJson', {
    text: String(text ?? '')
  });
}

export function mergeToolCallsWithNative(
  existing: Array<Record<string, unknown>> | undefined,
  additions: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> {
  const capability = 'mergeToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const existingJson = safeStringify(existing ?? []);
  const additionsJson = safeStringify(additions ?? []);
  if (!existingJson || !additionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(existingJson, additionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapReasoningContentToResponsesOutputWithNative(
  reasoningContent: unknown
): Array<{ type: 'reasoning'; content: string }> {
  const capability = 'mapReasoningContentToResponsesOutputJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ type: 'reasoning'; content: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contentJson = safeStringify(reasoningContent ?? null);
  if (!contentJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contentJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReasoningItems(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function validateToolArgumentsWithNative(
  toolName: string | undefined,
  args: unknown
): { repaired: string; success: boolean; error?: string } {
  const capability = 'validateToolArgumentsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ repaired: string; success: boolean; error?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ toolName, args: args ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.repaired !== 'string' || typeof parsed.success !== 'boolean') {
      return fail('invalid payload');
    }
    const error = typeof parsed.error === 'string' ? parsed.error : undefined;
    return { repaired: parsed.repaired, success: parsed.success, ...(error ? { error } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairToolCallsWithNative(
  toolCalls: Array<{ name?: string; arguments?: unknown }>
): Array<{ name?: string; arguments: string }> {
  const capability = 'repairToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ name?: string; arguments: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed.filter((entry): entry is { name?: string; arguments: string } =>
      entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).arguments === 'string'
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
