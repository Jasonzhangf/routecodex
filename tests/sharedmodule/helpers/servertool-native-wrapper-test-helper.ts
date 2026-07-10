import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath-loader.js';

function stringifyNativeJsonArg(capability: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[servertool-native-test] ${capability} JSON stringify failed: ${detail}`);
  }
}

export function invokeServertoolNativeCapability(capability: string, input: unknown): unknown {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[servertool-native-test] ${capability} not available`);
  }
  const raw = (fn as (inputJson: string) => unknown)(stringifyNativeJsonArg(capability, input));
  if (raw instanceof Error) {
    throw new Error(raw.message || `[servertool-native-test] ${capability} native error`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
    throw new Error(String((raw as { message: unknown }).message));
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[servertool-native-test] ${capability} returned non-string or empty result`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[servertool-native-test] ${capability} JSON parse failed: ${detail}`);
  }
}

export const buildClientExecCliProjectionOutputWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('buildClientExecCliProjectionOutputJson', input);
export const buildClientVisibleProjectionShellWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('buildClientVisibleProjectionShellJson', input);
export const buildServertoolCliProjectionExecutionContextWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('buildServertoolCliProjectionExecutionContextJson', input);
export const buildServertoolCliProjectionRuntimeBranchWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('buildServertoolCliProjectionRuntimeBranchJson', input);
export const formatStopMessageCompareContextWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('formatStopMessageCompareContextJson', input);
export const inspectStopGatewaySignalWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('inspectStopGatewaySignal', input);
export const normalizeStopMessageCompareContextWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('normalizeStopMessageCompareContextJson', input);
export const parseServertoolCliProjectionToolArgumentsWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('parseServertoolCliProjectionToolArgumentsJson', input);
export const planAutoHookCallerFinalizationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planAutoHookCallerFinalizationJson', input);
export const planAutoHookCallerResultProjectionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planAutoHookCallerResultProjectionJson', input);
export const planAutoHookRuntimeAttemptWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planAutoHookRuntimeAttemptJson', input);
export const planEngineSelectionAfterRunWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planEngineSelectionAfterRunJson', input);
export const planServertoolEngineOrchestrationPreflightActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEngineOrchestrationPreflightActionJson', input);
export const planServertoolEnginePreflightWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEnginePreflightJson', input);
export const planServertoolEnginePrepassActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEnginePrepassActionJson', input);
export const planServertoolEngineRuntimeActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEngineRuntimeActionJson', input);
export const planServertoolEngineSkipWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEngineSkipJson', input);
export const planServertoolEngineTriggerObservationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEngineTriggerObservationJson', input);
export const planServertoolEntryPreflightWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEntryPreflightJson', input);
export const planServertoolExecutionBranchWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolExecutionBranchJson', input);
export const planServertoolExecutionLoopEffectWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolExecutionLoopEffectJson', input);
export const planServertoolExecutionLoopRuntimeActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolExecutionLoopRuntimeActionJson', input);
export const planServertoolExecutionOutcomeMaterializationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolExecutionOutcomeMaterializationJson', input);
export const planServertoolExecutionOutcomeRuntimeActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolExecutionOutcomeRuntimeActionJson', input);
export const planServertoolRegistryAutoHookDescriptorsWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability(
    'planServertoolRegistryAutoHookDescriptorsJson',
    input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as { hooks?: unknown }).hooks)
      ? (input as { hooks: unknown[] }).hooks
      : input
  );
export const planServertoolRegistryLookupActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolRegistryLookupActionJson', input);
export const planServertoolRegistryProjectionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolRegistryProjectionJson', input);
export const planServertoolResponseStageRuntimeActionWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolResponseStageRuntimeActionJson', input);
export const resolveServertoolEntryPreflightApplicationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolEntryPreflightApplicationJson', input);
export const resolveServertoolResponseStagePrepassInitialApplicationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolResponseStagePrepassInitialApplicationJson', input);
export const resolveServertoolRunEngineEntryPreflightApplicationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolRunEngineEntryPreflightApplicationJson', input);
export const resolveServertoolRunEnginePrepassApplicationWithNative = (input: unknown): unknown =>
  invokeServertoolNativeCapability('planServertoolRunEnginePrepassApplicationJson', input);
