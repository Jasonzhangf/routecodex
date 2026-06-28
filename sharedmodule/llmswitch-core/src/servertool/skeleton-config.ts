import type {
  ServertoolTriggerMode,
  ServertoolAutoHookPhase,
  ServertoolExecutionMode,
  ServertoolSkeletonStageConfig,
  ServertoolSkeletonConfig,
  ServertoolStateConfig,
  ServertoolToolSpec,
  ServertoolSkeletonDocument,
  ServerToolHandlerRegistrationSpec,
  ServerToolRegisteredHandlerRecord,
} from '../native/router-hotpath/native-followup-mainline-semantics.js';
import {
  getDefaultServertoolSkeletonDocumentWithNative,
  normalizeServertoolRegistrationSpecWithNative,
  planServertoolBuiltinHandlerEntryWithNative,
  planServertoolBuiltinHandlerNamesWithNative,
  planServertoolRegistryLookupFromSkeletonWithNative,
  planServertoolRegistryRegistrationFromSkeletonWithNative,
  planServertoolSkeletonDerivedConfigWithNative,
  resolveServertoolRegisteredNameWithNative,
  resolveServertoolToolSpecWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export type {
  ServertoolTriggerMode,
  ServertoolAutoHookPhase,
  ServertoolExecutionMode,
  ServertoolSkeletonStageConfig,
  ServertoolSkeletonConfig,
  ServertoolStateConfig,
  ServertoolToolSpec,
  ServertoolSkeletonDocument,
  ServerToolHandlerRegistrationSpec,
  ServerToolRegisteredHandlerRecord,
} from '../native/router-hotpath/native-followup-mainline-semantics.js';

export type ServertoolResponseHookGateConfig = Record<string, unknown>;

type ServertoolFlowProfile = {
  noFollowup?: boolean;
  autoLimit?: boolean;
  flowOnlyLoopLimit?: boolean;
  clientInjectOnly?: boolean;
  clearStateOnFollowupFailure?: boolean;
  seedLoopPayload?: boolean;
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
  ignoreRequiresActionFollowup?: boolean;
};

type ServertoolFollowupConfig = {
  genericInjectionOps: string[];
  nativeSupportedOps: string[];
  flowPolicy: {
    profilesByFlowId: Record<string, ServertoolFlowProfile>;
    noFollowupFlowIds: string[];
    autoLimitFlowIds: string[];
    flowOnlyLoopLimitFlowIds: string[];
    clientInjectOnlyFlowIds: string[];
    seedLoopPayloadFlowIds: string[];
    clientInjectSourceByFlowId: Record<string, string>;
    transparentReplayRequestSuffixByFlowId: Record<string, string>;
    ignoreRequiresActionFollowupFlowIds: string[];
  };
};

type ServertoolSkeletonDerivedConfig = {
  document: ServertoolSkeletonDocument;
  toolSpecs: Record<string, ServertoolToolSpec>;
  toolSpecList: ServertoolToolSpec[];
  autoHookQueueConfig: {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
  pendingInjectionConfig: {
    messageKinds: string[];
  };
  responseHookGateConfig: ServertoolResponseHookGateConfig;
  followupConfig: ServertoolFollowupConfig;
  stateConfig: ServertoolStateConfig;
};

function getDerivedConfig(): ServertoolSkeletonDerivedConfig {
  return planServertoolSkeletonDerivedConfigWithNative() as ServertoolSkeletonDerivedConfig;
}

export function getDefaultServertoolSkeletonDocument(): ServertoolSkeletonDocument {
  return getDefaultServertoolSkeletonDocumentWithNative() as unknown as ServertoolSkeletonDocument;
}

export function getServertoolToolSpec(name: string): ServertoolToolSpec | null {
  return resolveServertoolToolSpecWithNative({ name }) as unknown as ServertoolToolSpec | null;
}

export function planServertoolBuiltinHandlerEntry(name: string): Record<string, unknown> {
  return planServertoolBuiltinHandlerEntryWithNative({ name }) as unknown as Record<string, unknown>;
}

export function planServertoolBuiltinHandlerNames(): string[] {
  return planServertoolBuiltinHandlerNamesWithNative().names;
}

export function planServertoolRegistryRegistrationFromSkeleton(input: {
  name: string;
  hasHandler: boolean;
}): ReturnType<typeof planServertoolRegistryRegistrationFromSkeletonWithNative> {
  return planServertoolRegistryRegistrationFromSkeletonWithNative(input);
}

export function planServertoolRegistryLookupFromSkeleton(input: {
  name: string;
  adHocEntryPresent: boolean;
}): ReturnType<typeof planServertoolRegistryLookupFromSkeletonWithNative> {
  return planServertoolRegistryLookupFromSkeletonWithNative(input);
}

export function isServertoolRegisteredNameByConfig(name: string): boolean {
  return resolveServertoolRegisteredNameWithNative({ name });
}

export function listServertoolToolSpecs(): ServertoolToolSpec[] {
  return getDerivedConfig().toolSpecList;
}

export function normalizeServerToolRegistrationSpec(
  name: string,
  options: {
    trigger?: ServertoolTriggerMode;
    priority?: number;
    phase?: ServertoolAutoHookPhase | string;
    executionMode?: ServertoolExecutionMode;
    hook?: {
      priority?: number;
      phase?: ServertoolAutoHookPhase | string;
    };
  } = {}
): ServerToolHandlerRegistrationSpec | null {
  return normalizeServertoolRegistrationSpecWithNative({
    name,
    options: options as Record<string, unknown>
  }) as unknown as ServerToolHandlerRegistrationSpec | null;
}

export function buildServertoolAutoHookQueueConfig(): {
  optionalPrimaryOrder: string[];
  mandatoryOrder: string[];
} {
  return getDerivedConfig().autoHookQueueConfig;
}

export function buildServertoolPendingInjectionConfig(): {
  messageKinds: string[];
} {
  return getDerivedConfig().pendingInjectionConfig;
}

export function buildServertoolResponseHookGateConfig(): ServertoolResponseHookGateConfig {
  return getDerivedConfig().responseHookGateConfig;
}

export function buildServertoolFollowupConfig(): ServertoolFollowupConfig {
  return getDerivedConfig().followupConfig;
}

export function buildServertoolStateConfig(): ServertoolStateConfig {
  return getDerivedConfig().stateConfig;
}

export function isServertoolEnabledByConfig(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled !== false;
}
