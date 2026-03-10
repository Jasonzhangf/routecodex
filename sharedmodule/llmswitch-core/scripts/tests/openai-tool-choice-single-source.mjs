#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const distRoot = path.join(projectRoot, 'dist');

async function main() {
  const { OpenAIOpenAIPipelineCodec } = await import(
    url.pathToFileURL(path.join(distRoot, 'conversion/pipeline/codecs/v2/openai-openai-pipeline.js')).href
  );

  const codec = new OpenAIOpenAIPipelineCodec({});
  await codec.initialize();

  const payload = {
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files',
          parameters: { type: 'object', properties: {} }
        }
      }
    ],
    tool_choice: 'required',
    parallel_tool_calls: true
  };

  const result = await codec.convertRequest(
    payload,
    { protocol: 'openai-chat', request: 'openai-chat', response: 'openai-chat' },
    { requestId: 'req_openai_tool_choice_single_source', entryEndpoint: '/v1/chat/completions' }
  );

  assert.equal(result.tool_choice, 'required');
  assert.equal(result.parallel_tool_calls, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'parameters'), false);

  console.log('✅ openai tool_choice single-source regression passed');
}

main().catch((error) => {
  console.error('❌ openai tool_choice single-source regression failed:', error);
  process.exit(1);
});
