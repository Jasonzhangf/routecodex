import { describe, expect, test } from '@jest/globals';

import {
  attachStopGatewayContext,
  inspectStopGatewaySignal,
  readStopGatewayContext,
  resolveStopGatewayContext
} from '../../sharedmodule/llmswitch-core/src/servertool/stop-gateway-context.js';

describe('servertool stop-gateway context', () => {
  test('uses native inspect and preserves the last finish_reason choice index', () => {
    const context = inspectStopGatewaySignal({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'old' }
        },
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: 'latest' }
        }
      ]
    });

    expect(context).toEqual({
      observed: true,
      eligible: false,
      source: 'chat',
      reason: 'finish_reason_length',
      choiceIndex: 1,
      hasToolCalls: false
    });
  });

  test('native inspect detects spaced uppercase embedded tool marker', () => {
    const context = inspectStopGatewaySignal({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '<|  TOOL_CALL_BEGIN  |>test' }
      }]
    });

    expect(context.eligible).toBe(false);
    expect(context.reason).toBe('finish_reason_stop_with_embedded_tool_markers');
  });

  test('reads metadata context through native normalization', () => {
    const context = readStopGatewayContext({
      __rt: {
        stopGatewayContext: {
          observed: true,
          eligible: false,
          source: ' RESPONSES ',
          reason: ' responses_required_action ',
          choiceIndex: 2.8,
          hasToolCalls: true
        }
      }
    });

    expect(context).toEqual({
      observed: true,
      eligible: false,
      source: 'responses',
      reason: 'responses_required_action',
      choiceIndex: 2,
      hasToolCalls: true
    });
  });

  test('metadata context wins over payload inspect', () => {
    const context = resolveStopGatewayContext(
      {
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'eligible' }
        }]
      },
      {
        __rt: {
          stopGatewayContext: {
            observed: true,
            eligible: false,
            source: 'chat',
            reason: 'metadata_override'
          }
        }
      }
    );

    expect(context.eligible).toBe(false);
    expect(context.reason).toBe('metadata_override');
  });

  test('attach writes explicit runtime metadata context', () => {
    const adapterContext: Record<string, unknown> = {};
    attachStopGatewayContext(adapterContext as any, {
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    });

    expect(readStopGatewayContext(adapterContext)).toEqual({
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    });
  });
});
