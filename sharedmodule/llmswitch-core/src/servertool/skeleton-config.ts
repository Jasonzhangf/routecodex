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
  planServertoolSkeletonDerivedConfigWithNative,
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
  contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
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
    contextDecorationModeByFlowId: Record<string, 'continue_execution_summary' | 'web_search_summary'>;
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
