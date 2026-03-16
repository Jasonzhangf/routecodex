import { describe, expect, it } from '@jest/globals';

import { ResponsesOpenAIPipelineCodec } from '../../sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/responses-openai-pipeline.js';

describe('responses openai pipeline request parameter preservation', () => {
  it('preserves reasoning fields into chat parameters for outbound protocol mapping', async () => {
    const codec = new ResponsesOpenAIPipelineCodec();
    await codec.initialize();

    const result = await codec.convertRequest(
      {
        model: 'gpt-5.4',
        reasoning: { effort: 'high', summary: 'detailed' },
        include: ['reasoning.encrypted_content'],
        text: { verbosity: 'high' },
        prompt_cache_key: 'cache-key-1',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
          }
        ]
      },
      {
        id: 'responses-openai-v2-test',
        incomingProtocol: 'openai-responses',
        outgoingProtocol: 'openai-chat',
        codec: 'responses-openai-v2'
      } as any,
      {
        requestId: 'req_responses_pipeline_reasoning_preserve',
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        metadata: {}
      } as any
    );

    expect((result as any).model).toBe('gpt-5.4');
    expect((result as any).parameters).toMatchObject({
      model: 'gpt-5.4',
      reasoning: { effort: 'high', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'high' },
      prompt_cache_key: 'cache-key-1',
      stream: true
    });
  });
});
