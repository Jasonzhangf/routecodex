import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from '../../shared/common-utils.js';

type StopMessageRouterMetadataOutput = {
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
};

const NON_BLOCKING_METADATA_POLICY_LOG_THROTTLE_MS = 60_000;
const nonBlockingMetadataPolicyLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-orchestration-semantics-metadata-policy.parse-failed');

function logNativeMetadataPolicyNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingMetadataPolicyLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_METADATA_POLICY_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingMetadataPolicyLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-orchestration-semantics-metadata-policy] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeMetadataPolicyNonBlocking(stage, error);
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
    logNativeMetadataPolicyNonBlocking('safeStringify', error);
    return undefined;
  }
}

function parseStopMessageRouterMetadata(raw: string): StopMessageRouterMetadataOutput | null {
  const parsed = parseJson('parseStopMessageRouterMetadata', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const out: StopMessageRouterMetadataOutput = {};
  const assignIfNonEmpty = (key: keyof StopMessageRouterMetadataOutput): void => {
    const rawValue = row[key];
    if (typeof rawValue !== 'string') {
      return;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return;
    }
    out[key] = trimmed;
  };
  assignIfNonEmpty('stopMessageClientInjectSessionScope');
  assignIfNonEmpty('stopMessageClientInjectScope');
  assignIfNonEmpty('clientTmuxSessionId');
  assignIfNonEmpty('client_tmux_session_id');
  assignIfNonEmpty('tmuxSessionId');
  assignIfNonEmpty('tmux_session_id');
  return out;
}

export function resolveStopMessageRouterMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): StopMessageRouterMetadataOutput {
  const capability = 'resolveStopMessageRouterMetadataJson';
  const fail = (reason?: string): StopMessageRouterMetadataOutput =>
    failNativeRequired<StopMessageRouterMetadataOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStopMessageRouterMetadata(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
