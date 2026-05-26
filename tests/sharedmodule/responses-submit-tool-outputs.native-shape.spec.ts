import { describe, expect, it, jest } from '@jest/globals';

const mockBuildSubmitToolOutputsPayloadWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js',
  () => ({
    buildSubmitToolOutputsPayloadWithNative: mockBuildSubmitToolOutputsPayloadWithNative,
  })
);

describe('responses submit_tool_outputs native shape', () => {
  it('RED: accepts native camelCase submit payload shape and remaps to canonical responses fields', async () => {
    mockBuildSubmitToolOutputsPayloadWithNative.mockReturnValue({
      responseId: 'resp_native_shape_1',
      toolOutputs: [
        {
          toolCallId: 'call_native_shape_1',
          id: 'call_native_shape_1',
          output: 'ok',
        },
      ],
      model: 'gpt-5.4',
      stream: true,
    });

    const { buildSubmitToolOutputsPayload } = await import(
      '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/responses-submit-tool-outputs.js'
    );

    const result = buildSubmitToolOutputsPayload(
      {
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { model: 'gpt-5.4', stream: true },
      } as any,
      { entryEndpoint: '/v1/responses.submit_tool_outputs' } as any,
      { previous_response_id: 'resp_native_shape_1' } as any,
    );

    expect(result.response_id).toBe('resp_native_shape_1');
    expect(result.tool_outputs).toEqual([
      {
        toolCallId: 'call_native_shape_1',
        id: 'call_native_shape_1',
        output: 'ok',
      },
    ]);
    expect(result.model).toBe('gpt-5.4');
    expect(result.stream).toBe(true);
  });
});
