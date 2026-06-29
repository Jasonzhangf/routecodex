import { describe, expect, it } from '@jest/globals';

import { defaultSseCodecRegistry } from '../../sharedmodule/llmswitch-core/src/sse/registry/sse-codec-registry.js';

describe('SSE codec registry no model fallback boundary', () => {
  it('throws when JSON to SSE conversion cannot resolve a model id', async () => {
    const codec = defaultSseCodecRegistry.get('openai-chat');

    await expect(codec.convertJsonToSse(
      { id: 'chatcmpl_missing_model', choices: [] },
      { requestId: 'req_sse_registry_missing_model' }
    )).rejects.toThrow('Missing SSE model id');
  });
});
