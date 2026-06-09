import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeReqProcessToolGovernanceInput {
  request: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  entryEndpoint: string;
  requestId: string;
  hasActiveStopMessageForContinueExecution?: boolean;
}

export interface NativeReqProcessToolGovernanceOutput {
  processedRequest: Record<string, unknown>;
  nodeResult: Record<string, unknown>;
}

function parseToolGovernanceOutput(raw: string): NativeReqProcessToolGovernanceOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const processedRequest = row.processedRequest;
    const nodeResult = row.nodeResult;
    if (!processedRequest || typeof processedRequest !== 'object' || Array.isArray(processedRequest)) {
      return null;
    }
    if (!nodeResult || typeof nodeResult !== 'object' || Array.isArray(nodeResult)) {
      return null;
    }
    return {
      processedRequest: processedRequest as Record<string, unknown>,
      nodeResult: nodeResult as Record<string, unknown>
    };
  } catch {
    return null;
  }
}

export function applyReqProcessToolGovernanceWithNative(
  input: NativeReqProcessToolGovernanceInput
): NativeReqProcessToolGovernanceOutput {
  const capability = 'applyReqProcessToolGovernanceJson';
  const fail = (reason?: string): NativeReqProcessToolGovernanceOutput =>
    failNativeRequired<NativeReqProcessToolGovernanceOutput>(capability, reason);

  const fn = readNativeFunction('applyReqProcessToolGovernanceJson');
  if (!fn) {
    return fail();
  }

  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }

  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolGovernanceOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
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
  } catch {
    return undefined;
  }
}
