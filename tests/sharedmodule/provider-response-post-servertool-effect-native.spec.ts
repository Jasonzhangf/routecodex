import { describe, expect, it } from '@jest/globals';

import {
  resolveProviderResponsePostServertoolEffectWithNative,
  type ProviderResponseServertoolRuntimeActionPlan,
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

describe('provider response post-servertool native effect planner', () => {
  it('uses orchestration payload and governed stage when orchestration executed', () => {
    const actionPlan: ProviderResponseServertoolRuntimeActionPlan = {
      executionPlans: [{
        payload: { id: 'planned' },
        projectionStage: 'HubRespChatProcess03Governed',
        allowFollowup: false,
      }],
      error: null,
    };

    const output = resolveProviderResponsePostServertoolEffectWithNative({
      actionPlan,
      currentPayload: { id: 'current' },
      orchestrationPayload: { id: 'governed' },
      orchestrationExecuted: true,
    });

    expect(output).toEqual({
      payload: { id: 'governed' },
      stage: 'HubRespChatProcess03Governed',
      shouldProjectClientSemantic: true,
    });
  });

  it('keeps current payload and unchanged stage when orchestration did not execute', () => {
    const actionPlan: ProviderResponseServertoolRuntimeActionPlan = {
      executionPlans: [{
        payload: { id: 'planned' },
        projectionStage: 'HubRespChatProcess03Governed',
        allowFollowup: false,
      }],
      error: null,
    };

    const output = resolveProviderResponsePostServertoolEffectWithNative({
      actionPlan,
      currentPayload: { id: 'current' },
      orchestrationPayload: { id: 'ignored' },
      orchestrationExecuted: false,
    });

    expect(output).toEqual({
      payload: { id: 'current' },
      stage: 'unchanged',
      shouldProjectClientSemantic: false,
    });
  });
});
