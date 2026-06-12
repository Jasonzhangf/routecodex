import { describe, expect, it } from '@jest/globals';
import { isProviderNativeResumeContinuation } from '../../../../../src/server/runtime/http-server/executor/request-executor-request-semantics.js';

describe('request executor request semantics', () => {
  it('does not mark inline function_call_output history as provider-owned resume', () => {
    expect(isProviderNativeResumeContinuation({
      toolOutputs: [{ call_id: 'call_1', output: 'ok', type: 'function_call_output' }]
    })).toBe(false);
  });

  it('marks previous response resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuation({
      continuation: {
        resumeFrom: {
          previousResponseId: 'resp_1'
        }
      }
    })).toBe(true);
  });

  it('marks submit_tool_outputs response id resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuation({
      continuation: {
        mode: 'submit_tool_outputs',
        responseId: 'resp_1'
      }
    })).toBe(true);
  });
});
