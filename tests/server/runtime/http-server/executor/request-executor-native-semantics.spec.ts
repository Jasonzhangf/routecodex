import { describe, expect, it } from '@jest/globals';
import {
  isProviderNativeResumeContinuationNative,
  isToolResultFollowupTurnNative,
} from '../../../../../src/modules/llmswitch/bridge/native-exports.js';

describe('request executor native request semantics', () => {
  it('does not mark inline function_call_output history as provider-owned resume', () => {
    expect(isProviderNativeResumeContinuationNative({
      toolOutputs: [{ call_id: 'call_1', output: 'ok', type: 'function_call_output' }]
    })).toBe(false);
  });

  it('does not mark relay previous response resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuationNative({
      continuation: {
        continuationOwner: 'relay',
        resumeFrom: {
          previousResponseId: 'resp_relay_1'
        }
      }
    })).toBe(false);
  });

  it('does not mark relay submit_tool_outputs response id resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuationNative({
      continuation: {
        continuationOwner: 'relay',
        mode: 'submit_tool_outputs',
        responseId: 'resp_relay_1'
      }
    })).toBe(false);
  });

  it('marks previous response resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuationNative({
      continuation: {
        continuationOwner: 'direct',
        resumeFrom: {
          previousResponseId: 'resp_1'
        }
      }
    })).toBe(true);
  });

  it('marks submit_tool_outputs response id resume as provider-owned continuation', () => {
    expect(isProviderNativeResumeContinuationNative({
      continuation: {
        continuationOwner: 'direct',
        mode: 'submit_tool_outputs',
        responseId: 'resp_1'
      }
    })).toBe(true);
  });

  it('marks multi-turn assistant tool_calls plus tool-result history as a tool-result followup turn', () => {
    expect(isToolResultFollowupTurnNative({
      messages: [
        {
          role: 'system',
          content: 'system guidance'
        },
        {
          role: 'user',
          content: 'investigate rust crates'
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_prev_1',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: '{"path":"sharedmodule/llmswitch-core/src/servertool"}'
              }
            },
            {
              id: 'call_prev_2',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: '{"path":"sharedmodule/llmswitch-core/rust-core/crates"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_prev_1',
          content: 'stop-message-auto.ts\\nengine.ts'
        },
        {
          role: 'tool',
          tool_call_id: 'call_prev_2',
          content: 'servertool-core\\nservertool-cli'
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_curr_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_curr_1',
          content: 'pub mod orchestration;'
        }
      ]
    })).toBe(true);
  });
});
