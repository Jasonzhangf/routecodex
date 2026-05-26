import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
  applyStopMessageFinishReasonBudget,
  incrementStopMessageErrorBudget
} from '../../src/servertool/stop-message-counter.js';
import { loadRoutingInstructionStateSync, saveRoutingInstructionStateSync } from '../../src/router/virtual-router/sticky-session-store.js';

const STICKY_KEY = 'session:stop-counter-test';

function readUsed(): number {
  const state = loadRoutingInstructionStateSync(STICKY_KEY);
  return typeof state?.stopMessageUsed === 'number' ? state.stopMessageUsed : 0;
}

describe('stop message counter', () => {
  let tempDir: string;
  let prevSessionDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stop-counter-'));
    prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    process.env.ROUTECODEX_SESSION_DIR = tempDir;
    saveRoutingInstructionStateSync(STICKY_KEY, null);
  });

  afterEach(() => {
    saveRoutingInstructionStateSync(STICKY_KEY, null);
    if (prevSessionDir === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('stop and error share the same budget until a tool call resets it', () => {
    const adapterContext = {
      requestId: 'req_stop_counter_1',
      sessionId: 'stop-counter-test',
      providerProtocol: 'openai-chat'
    };

    const firstStop = applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'first stop' } }]
      }
    });
    expect(firstStop.used).toBe(1);
    expect(readUsed()).toBe(1);

    const error = incrementStopMessageErrorBudget({ adapterContext });
    expect(error.used).toBe(2);
    expect(readUsed()).toBe(2);

    const nonStopToolCall = applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }]
          }
        }]
      }
    });
    expect(nonStopToolCall.stopEligible).toBe(false);
    expect(nonStopToolCall.used).toBe(0);
    expect(readUsed()).toBe(0);

    const nextStop = applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'second cycle stop' } }]
      }
    });
    expect(nextStop.used).toBe(1);
    expect(readUsed()).toBe(1);
  });

  test('non-tool errors never reset the stop budget', () => {
    const adapterContext = {
      requestId: 'req_stop_counter_2',
      sessionId: 'stop-counter-test',
      providerProtocol: 'openai-responses'
    };

    applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }]
      }
    });
    expect(readUsed()).toBe(1);

    incrementStopMessageErrorBudget({ adapterContext });
    expect(readUsed()).toBe(2);

    incrementStopMessageErrorBudget({ adapterContext });
    expect(readUsed()).toBe(3);
  });

  test('responses non-call tool-like output must not reset the stop budget', () => {
    const adapterContext = {
      requestId: 'req_stop_counter_3',
      sessionId: 'stop-counter-test',
      providerProtocol: 'openai-responses'
    };

    applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'first stop' } }]
      }
    });
    incrementStopMessageErrorBudget({ adapterContext });
    expect(readUsed()).toBe(2);

    const nonCallToolLike = applyStopMessageFinishReasonBudget({
      adapterContext,
      payload: {
        id: 'resp_non_call_tool_like',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'tool_result',
            call_id: 'call_old',
            output: 'previous tool output'
          }
        ]
      }
    });
    expect(nonCallToolLike.observed).toBe(true);
    expect(nonCallToolLike.stopEligible).toBe(false);
    expect(nonCallToolLike.used).toBe(2);
    expect(readUsed()).toBe(2);
  });
});
