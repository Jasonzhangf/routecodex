#!/usr/bin/env node
/**
 * Minimal Responses client using the same OpenAI SDK
 * semantics as tools/responses-debug-client, for testing
 * upstream /v1/responses SSE behaviour.
 */

import OpenAI from 'openai';

const baseURL = process.argv[2] || 'https://www.fakercode.top/v1';
const apiKey =
  process.argv[3] ||
  process.env.FC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

if (!apiKey) {
  console.error('FC_API_KEY / OPENAI_API_KEY is required');
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });

const payload = {
  model: process.env.FC_MODEL || 'gpt-5.1',
  input: [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '用一句话说“你好”，不要解释。'
        }
      ]
    }
  ],
  stream: true
};

console.log('BASE_URL', baseURL);
console.log('MODEL', payload.model);

try {
  const stream = await client.responses.stream(payload);
  console.log('STREAM_OK');
  for await (const event of stream) {
    console.log('EVENT', JSON.stringify(event));
  }
} catch (err) {
  console.log('STREAM_ERROR');
  console.log(
    JSON.stringify(
      {
        name: err?.name,
        message: err?.message,
        status: err?.status,
        code: err?.code,
        type: err?.type,
        data: err?.response?.data
      },
      null,
      2
    )
  );
  process.exit(1);
}
