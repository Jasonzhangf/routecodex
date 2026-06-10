import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from '../../shared/common-utils.js';

export type NativeContextToolOutput = { tool_call_id: string; call_id: string; output?: string; name?: string };

const NON_BLOCKING_INBOUND_OUTBOUND_LOG_THROTTLE_MS = 60_000;
const nonBlockingInboundOutboundLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-inbound-outbound-semantics.parse-failed');


function logNativeInboundOutboundNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingInboundOutboundLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_INBOUND_OUTBOUND_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingInboundOutboundLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-inbound-outbound-semantics] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeInboundOutboundNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logNativeInboundOutboundNonBlocking('safeStringify', error);
    return undefined;
  }
}

function parseToolOutputEntry(raw: unknown): NativeContextToolOutput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const toolCallId =
    (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
    (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
    (typeof row.call_id === 'string' && row.call_id.trim()) ||
    (typeof row.callId === 'string' && row.callId.trim()) ||
    '';
  const callId =
    (typeof row.call_id === 'string' && row.call_id.trim()) ||
    (typeof row.callId === 'string' && row.callId.trim()) ||
    (typeof row.tool_call_id === 'string' && row.tool_call_id.trim()) ||
    (typeof row.toolCallId === 'string' && row.toolCallId.trim()) ||
    '';
  if (!toolCallId || !callId) {
    return null;
  }

  const outputRaw = row.output;
  let output: string | undefined;
  if (typeof outputRaw === 'string') {
    output = outputRaw;
  } else if (outputRaw !== undefined) {
    try {
      output = JSON.stringify(outputRaw);
    } catch {
      output = String(outputRaw);
    }
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
  return {
    tool_call_id: toolCallId,
    call_id: callId,
    ...(output !== undefined ? { output } : {}),
    ...(name ? { name } : {})
  };
}

function parseCollectedToolOutputs(raw: string): NativeContextToolOutput[] | null {
  const parsed = parseJson('parseCollectedToolOutputs', raw);
  if (parsed === JSON_PARSE_FAILED || !Array.isArray(parsed)) {
    return null;
  }
  const out: NativeContextToolOutput[] = [];
  for (const entry of parsed) {
    const normalized = parseToolOutputEntry(entry);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

export function collectToolOutputsWithNative(
  payload: unknown
): NativeContextToolOutput[] {
  const capability = 'collectToolOutputsJson';
  const fail = (reason?: string) => failNativeRequired<NativeContextToolOutput[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('collectToolOutputsJson');
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseCollectedToolOutputs(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
