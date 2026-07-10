import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

import {
  inspectStopGatewaySignalWithNative
} from '../sharedmodule/helpers/servertool-native-wrapper-test-helper.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const TEST_WRITER = {
  module: 'tests/servertool/stop-gateway-context.spec.ts',
  symbol: 'test',
  stage: 'HubRespChatProcess03Governed'
} as const;

describe('servertool stop-gateway context', () => {
  test('servertool metadata carrier shell stays physically deleted', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts')).toBe(false);
  });

  test('production native exports do not keep stop-gateway wrapper fan-out', () => {
    const source = fs.readFileSync('src/modules/llmswitch/bridge/native-exports.ts', 'utf8');

    expect(source).not.toContain('export function inspectStopGatewaySignalWithNative');
    expect(source).not.toContain('resolveStopGatewayContext');
    expect(source).not.toContain('isStopEligibleForServerTool');
    expect(source).not.toContain('readStopGatewayContext');
  });

  test('uses native inspect and preserves the last finish_reason choice index', () => {
    const context = inspectStopGatewaySignalWithNative({
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
      choice_index: 1,
      has_tool_calls: false
    });
  });

  test('native inspect detects spaced uppercase embedded tool marker', () => {
    const context = inspectStopGatewaySignalWithNative({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '<|  TOOL_CALL_BEGIN  |>test' }
      }]
    }) as Record<string, unknown>;

    expect(context.eligible).toBe(false);
    expect(context.reason).toBe('finish_reason_stop_with_embedded_tool_markers');
  });

  test('runtime control context is written through MetadataCenter API, not a servertool carrier shell', () => {
    const target: Record<string, unknown> = {};
    const center = MetadataCenter.attach(target);
    center.writeRuntimeControl('stopGatewayContext', {
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    }, TEST_WRITER, 'response stop gateway control signal');

    expect(target.__rt).toBeUndefined();
    expect(center.readRuntimeControl().stopGatewayContext).toEqual({
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    });
  });
});
