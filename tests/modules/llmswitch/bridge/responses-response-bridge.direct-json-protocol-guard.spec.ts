import { describe, expect, it } from '@jest/globals';

import {
  normalizeResponsesClientPayloadForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
} from '../../../../src/modules/llmswitch/bridge/responses-response-bridge.ts';

describe('responses-response-bridge direct JSON protocol guard', () => {
  it('router-direct JSON dispatch bypasses Responses client projection without requestContext', async () => {
    const body = {
      id: 'resp_direct_passthrough_no_context',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
    };

    const output = await prepareResponsesJsonClientDispatchPlanForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'direct',
      body,
      metadata: {},
    });

    expect(output).toEqual({
      clientBody: body,
      sanitizedBody: body,
    });
  });

  it('RED: direct owner side-channel must not skip Responses replay-safe client projection', async () => {
    const output = await normalizeResponsesClientPayloadForHttp({
      entryEndpoint: '/v1/responses',
      metadata: {},
      hasSsePayload: () => false,
      payload: {
        id: 'resp_direct_json_guard',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'rs_direct_json_guard',
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'plan' }],
            content: [{ type: 'reasoning_text', text: 'private reasoning leak' }],
            encrypted_content: 'opaque',
          },
          {
            id: 'fc_direct_json_guard',
            type: 'function_call',
            status: 'in_progress',
            name: 'exec_command',
            call_id: 'call_direct_json_guard',
            arguments: '{"cmd":"pwd"}',
          },
          {
            id: 'fco_direct_json_guard',
            type: 'function_call_output',
            status: 'completed',
            call_id: 'call_direct_json_guard',
            output: '/tmp/project',
          },
        ],
      },
      requestContext: {
        payload: {
          model: 'gpt-5.4',
          tools: [],
        },
        context: { toolsRaw: [] },
      },
    });

    expect(output).toEqual({
      id: 'resp_direct_json_guard',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'rs_direct_json_guard',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'plan' }],
          encrypted_content: 'opaque',
        },
        {
          id: 'fc_direct_json_guard',
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_direct_json_guard',
          arguments: '{"cmd":"pwd"}',
        },
        {
          id: 'fco_direct_json_guard',
          type: 'function_call_output',
          call_id: 'call_direct_json_guard',
          output: '/tmp/project',
        },
      ],
      model: 'gpt-5.4',
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('private reasoning leak');
    expect(serialized).not.toContain('"reasoning_text"');
    expect(serialized).not.toContain('"status":"in_progress"');
    expect(JSON.stringify((output as { output: unknown[] }).output)).not.toContain('"status":"completed"');
  });

  it('strips response metadata from JSON client projection even when native payload includes it', async () => {
    const output = await normalizeResponsesClientPayloadForHttp({
      entryEndpoint: '/v1/responses',
      metadata: {},
      payload: {
        id: 'resp_direct_json_metadata_guard',
        object: 'response',
        status: 'completed',
        metadata: {
          routeHint: 'thinking',
          providerKey: 'internal.provider',
        },
        output: [
          {
            id: 'msg_direct_json_metadata_guard',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            metadata: {
              routeHint: 'tools',
            },
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      },
      requestContext: {
        payload: {
          model: 'gpt-5.4',
          tools: [],
        },
        context: { toolsRaw: [] },
      },
    });

    expect(output).toEqual({
      id: 'resp_direct_json_metadata_guard',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'msg_direct_json_metadata_guard',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      model: 'gpt-5.4',
    });
    expect(JSON.stringify(output)).not.toContain('providerKey');
    expect(JSON.stringify(output)).not.toContain('routeHint');
    expect(JSON.stringify(output)).not.toContain('"metadata"');
  });
});
