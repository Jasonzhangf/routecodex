import { describe, expect, test } from '@jest/globals';
import {
  buildServertoolAutoHookQueueConfig,
  buildServertoolFollowupConfig,
  buildServertoolPendingInjectionConfig,
  getDefaultServertoolSkeletonDocument,
  getServertoolToolSpec,
  listServertoolToolSpecs,
  normalizeServerToolRegistrationSpec
} from '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js';
import '../../sharedmodule/llmswitch-core/src/servertool/handlers/recursive-detection-guard.js';
import '../../sharedmodule/llmswitch-core/src/servertool/handlers/clock-auto.js';
import '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.js';
import { listAutoServerToolHooks } from '../../sharedmodule/llmswitch-core/src/servertool/registry.js';
import { planServertoolAutoHookQueuesWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

describe('servertool skeleton config', () => {
  test('exposes declarative auto hook queue order from skeleton config', () => {
    const skeleton = getDefaultServertoolSkeletonDocument();
    expect(skeleton.servertool.skeleton.autoHooks.optionalPrimaryOrder).toEqual([
      'clock_auto',
      'stop_message_auto'
    ]);
    expect(buildServertoolAutoHookQueueConfig()).toEqual({
      optionalPrimaryOrder: ['clock_auto', 'stop_message_auto'],
      mandatoryOrder: []
    });
    expect(buildServertoolPendingInjectionConfig()).toEqual({
      messageKinds: ['assistant_tool_calls', 'tool_outputs']
    });
    expect(buildServertoolFollowupConfig()).toEqual({
      genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs']
    });
  });

  test('normalizes registration spec from config truth', () => {
    const spec = normalizeServerToolRegistrationSpec('reasoning_stop', {
      trigger: 'tool_call'
    });
    expect(spec).toMatchObject({
      name: 'reasoning.stop',
      enabled: true,
      trigger: 'tool_call',
      executionMode: 'guarded',
      stripAfterExecute: true
    });
  });

  test('per-tool spec is the authoritative source for trigger and mode', () => {
    const stopMessage = getServertoolToolSpec('stop_message_auto');
    expect(stopMessage).toMatchObject({
      name: 'stop_message_auto',
      trigger: {
        type: 'auto',
        canonicalName: 'stop_message_auto',
        phase: 'default',
        priority: 40
      },
      execution: {
        mode: 'auto_hook',
        stripAfterExecute: true
      }
    });

    const toolSpecs = listServertoolToolSpecs();
    expect(toolSpecs.some((entry) => entry.name === 'reasoning_stop_guard')).toBe(true);
  });

  test('native auto hook planner respects config primary order', () => {
    const hooks = listAutoServerToolHooks();
    const queueConfig = buildServertoolAutoHookQueueConfig();
    const plan = planServertoolAutoHookQueuesWithNative({
      hooks: hooks.map((hook) => ({
        id: hook.id,
        phase: hook.phase,
        priority: hook.priority,
        order: hook.order
      })),
      optionalPrimaryHookOrder: queueConfig.optionalPrimaryOrder,
      mandatoryHookOrder: queueConfig.mandatoryOrder
    });
    expect(plan.optionalQueue[0]?.id).toBe('recursive_detection_guard');
    expect(plan.optionalQueue.some((entry) => entry.id === 'clock_auto')).toBe(true);
    expect(plan.optionalQueue.some((entry) => entry.id === 'stop_message_auto')).toBe(true);
    expect(plan.mandatoryQueue).toEqual([]);
  });
});
