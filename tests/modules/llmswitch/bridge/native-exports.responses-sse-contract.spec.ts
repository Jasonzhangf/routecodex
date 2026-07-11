import { describe, expect, it } from '@jest/globals';

import {
  projectResponsesSseFrameForClientWithNative,
  updateResponsesContractProbeFromSseChunkWithNative,
  updateResponsesSseTransportTerminalStateWithNative
} from '../../../sharedmodule/helpers/resp-semantics-direct-native.js';

describe('native-exports responses SSE contract', () => {
  it('calls router_hotpath SSE projection with the native multi-arg contract', () => {
    const projected = projectResponsesSseFrameForClientWithNative({
      frame: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      eventName: 'response.created',
      data: {
        type: 'response.created',
        response: {
          id: 'resp_1',
          object: 'response',
          status: 'in_progress',
        },
      },
      toolsRaw: [],
      metadata: {},
      state: {
        pendingApplyPatchArgumentDeltas: {},
        applyPatchCallIds: [],
        emittedApplyPatchDoneCallIds: [],
      },
    });

    expect(projected).toEqual(
      expect.objectContaining({
        emit: expect.any(Boolean),
        frame: expect.any(String),
        state: expect.objectContaining({
          pendingApplyPatchArgumentDeltas: expect.any(Object),
          applyPatchCallIds: expect.any(Array),
          emittedApplyPatchDoneCallIds: expect.any(Array),
        }),
      })
    );
  });

  it('suppresses apply_patch output_item.added empty-args frames for freeform tools and keeps state', () => {
    const projected = projectResponsesSseFrameForClientWithNative({
      frame: 'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","name":"apply_patch","call_id":"call_patch","arguments":""}}\n\n',
      eventName: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          name: 'apply_patch',
          call_id: 'call_patch',
          arguments: '',
        },
      },
      toolsRaw: [
        {
          type: 'custom',
          name: 'apply_patch',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF\nend_patch: "*** End Patch" LF?\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: "*** Add File: " filename LF add_line+\ndelete_hunk: "*** Delete File: " filename LF\nupdate_hunk: "*** Update File: " filename LF change_move? change?\nfilename: /(.+)/\nadd_line: "+" /(.*)/ LF\nchange_move: "*** Move to: " filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: ("@@" | "@@ " /(.+)/) LF\nchange_line: ("+" | "-" | " ") /(.*)/ LF\neof_line: "*** End of File" LF\n%import common.LF',
          },
        },
      ],
      metadata: {},
      state: {
        pendingApplyPatchArgumentDeltas: {},
        applyPatchCallIds: [],
        emittedApplyPatchDoneCallIds: [],
      },
    });

    expect(projected.emit).toBe(false);
    expect(projected.frame).toBe('');
    expect(projected.state).toEqual(
      expect.objectContaining({
        applyPatchCallIds: ['call_patch'],
      })
    );
  });

  it('materializes chat completion chunk tool_calls into native-owned probe state', () => {
    const chunk = [
      'data: {"id":"chatcmpl_req_tool_terminal","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_req_tool_terminal","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":""}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_req_tool_terminal","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_req_tool_terminal","object":"chat.completion.chunk","model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const probe = updateResponsesContractProbeFromSseChunkWithNative(chunk, {});
    expect(probe).not.toEqual({});
    expect(probe).toEqual(
      expect.objectContaining({
        id: 'chatcmpl_req_tool_terminal',
        status: 'requires_action',
        output: [
          expect.objectContaining({
            type: 'function_call',
            call_id: 'call_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            status: 'completed'
          })
        ]
      })
    );

    expect(JSON.stringify(probe)).not.toContain('response.required_action');
  });

  it('keeps partial Responses terminal blocks in native-owned transport state', () => {
    const first = updateResponsesSseTransportTerminalStateWithNative({
      chunk: 'event: response.com',
      state: undefined,
    });
    expect(first.observedTerminal).toBe(false);

    const second = updateResponsesSseTransportTerminalStateWithNative({
      chunk: 'pleted\ndata: {"type":"response.completed","response":{"id":"resp_split_terminal","object":"response","status":"completed"}}\n\n',
      state: first.state,
    });

    expect(second.observedTerminal).toBe(true);
  });
});
