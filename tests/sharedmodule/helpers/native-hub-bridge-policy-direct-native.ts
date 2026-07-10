import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';
import {
  parseNativeJsonObjectOrFail,
  parseNativeJsonValueOrFail,
  readNativeFunction,
  safeStringify
} from './native-router-hotpath-loader.js';

export interface NativeBridgeActionDescriptor {
  name: string;
  options?: Record<string, unknown>;
}

export interface NativeBridgePhaseConfig {
  inbound?: NativeBridgeActionDescriptor[];
  outbound?: NativeBridgeActionDescriptor[];
}

export interface NativeBridgePolicy {
  id: string;
  protocol?: string;
  moduleType?: string;
  request?: NativeBridgePhaseConfig;
  response?: NativeBridgePhaseConfig;
}

type NativeBridgePolicyStage =
  | 'request_inbound'
  | 'request_outbound'
  | 'response_inbound'
  | 'response_outbound';

interface NativeResponsesBridgePolicyActionPlanInput {
  stage: NativeBridgePolicyStage;
  actions?: NativeBridgeActionDescriptor[];
  messages?: Array<Record<string, unknown>>;
}

export function hasDeclaredApplyPatchToolWithNative(payload: unknown): boolean {
  const capability = 'hasDeclaredApplyPatchToolJson';
  const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload ?? null]);
  const parsed = parseNativeJsonObjectOrFail<{ hasDeclaredApplyPatchTool?: unknown }>(
    capability,
    raw,
    'hasDeclaredApplyPatchToolWithNative'
  );
  return (parsed as { hasDeclaredApplyPatchTool?: unknown }).hasDeclaredApplyPatchTool === true;
}

export function evaluateResponsesDirectRouteDecisionWithNative(input: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  const capability = 'evaluateResponsesDirectRouteDecisionJson';
  const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [
    input.payload ?? {},
    input.inboundProtocol ?? '',
    input.applyPatchMode ?? '',
  ]);
  const parsed = parseNativeJsonObjectOrFail<Record<string, unknown>>(
    capability,
    raw,
    'evaluateResponsesDirectRouteDecisionWithNative'
  );
  return parsed as {
    providerWireValid: boolean;
    requiresHubRelay: boolean;
    reason?: string;
    hasDeclaredApplyPatchTool?: boolean;
  };
}

function invokeNativeStringCapability(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(...args);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
      return fail(String((raw as { message: unknown }).message));
    }
    return parseNativeStringResult(capability, raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseNativeStringResult(capability: string, raw: unknown): string {
  if (typeof raw === 'string' && raw.length) {
    return raw;
  }
  return failNativeRequired<string>(capability, 'empty result');
}

function invokeNativeStringCapabilityWithJsonArgs(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) {
      return fail('json stringify failed');
    }
    encodedArgs.push(encoded);
  }
  return invokeNativeStringCapability(capability, encodedArgs);
}

export function resolveBridgePolicyWithNative(options: {
  protocol?: string;
  moduleType?: string;
} | undefined): NativeBridgePolicy | undefined {
  const capability = 'resolveBridgePolicyJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgePolicy | undefined>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
    protocol: options?.protocol,
    moduleType: options?.moduleType
  }]);
    const parsed = parseNativeJsonValueOrFail<NativeBridgePolicy | null>(
      capability,
      raw,
      'resolveBridgePolicyWithNative'
    );
    return parsed ?? undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveBridgePolicyActionsWithNative(
  policy: NativeBridgePolicy | undefined,
  stage: NativeBridgePolicyStage
): NativeBridgeActionDescriptor[] | undefined {
  const capability = 'resolveBridgePolicyActionsJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeBridgeActionDescriptor[] | undefined>(capability, reason);
  try {
    const policyJson = safeStringify(policy ?? null);
    if (!policyJson) {
      return fail('json stringify failed');
    }
    const raw = invokeNativeStringCapability(capability, [policyJson, String(stage || '')]);
    const parsed = parseNativeJsonValueOrFail<NativeBridgeActionDescriptor[] | null>(
      capability,
      raw,
      'resolveBridgePolicyActionsWithNative'
    );
    return parsed ?? undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesBridgePolicyActionsWithNative(
  input: NativeResponsesBridgePolicyActionPlanInput
): NativeBridgeActionDescriptor[] | undefined {
  const capability = 'planResponsesBridgePolicyActionsJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeBridgeActionDescriptor[] | undefined>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
      stage: input.stage,
      actions: input.actions ?? [],
      messages: input.messages ?? []
    }]);
    const parsed = parseNativeJsonValueOrFail<NativeBridgeActionDescriptor[] | null>(
      capability,
      raw,
      'planResponsesBridgePolicyActionsWithNative'
    );
    return parsed ?? undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeProviderOutboundPayloadWithNative(input: {
  protocol?: string;
  compatibilityProfile?: string;
  enforceLayout?: boolean;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'sanitizeProviderOutboundPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [{
      protocol: input?.protocol,
      compatibilityProfile: input?.compatibilityProfile,
      enforceLayout: input?.enforceLayout,
      payload: input?.payload ?? {}
    }]);
    const parsed = parseNativeJsonObjectOrFail<Record<string, unknown>>(
      capability,
      raw,
      'sanitizeProviderOutboundPayload'
    );
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
