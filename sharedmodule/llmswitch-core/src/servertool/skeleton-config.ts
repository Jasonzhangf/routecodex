import {
  planServertoolSkeletonDerivedConfigWithNative,
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

type ServertoolSkeletonDerivedConfig = {
  autoHookQueueConfig: {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
};

function getDerivedConfig(): ServertoolSkeletonDerivedConfig {
  return planServertoolSkeletonDerivedConfigWithNative() as ServertoolSkeletonDerivedConfig;
}

export function buildServertoolAutoHookQueueConfig(): {
  optionalPrimaryOrder: string[];
  mandatoryOrder: string[];
} {
  return getDerivedConfig().autoHookQueueConfig;
}
