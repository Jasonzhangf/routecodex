#!/usr/bin/env node

/**
 * Pipeline test script: Chat + Tools via HTTP router → Pipeline (LLMSwitch → Workflow → Compatibility → Provider)
 *
 * Usage:
 *   # Ensure the server is running (npm run dev) and LM Studio is up with the target model loaded
 *   # Optional envs:
 *   #   SERVER_URL            (default: http://localhost:5506)
 *   #   LMSTUDIO_MODEL        (default: gpt-oss-20b-mlx)
 *   #   TOOL_NAME             (default: add)
 *   #   TOOL_ARGS_JSON        (default: {"a":2,"b":3})
 *
 *   node scripts/test-pipeline-lmstudio-tools.mjs
 */

import process from 'node:process';

async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch;
  const mod = await import('node-fetch');
  return mod.default;
}

function readEnv(name, fallback) {
  const v = process.env[name];
  return (v !== undefined && v !== '') ? v : fallback;
}

const SERVER_URL = readEnv('SERVER_URL', 'http://localhost:5506');
const MODEL = readEnv('LMSTUDIO_MODEL', 'gpt-oss-20b-mlx');
const TOOL_NAME = readEnv('TOOL_NAME', 'add');
let TOOL_ARGS;
try {
  TOOL_ARGS = JSON.parse(readEnv('TOOL_ARGS_JSON', '{"a":2,"b":3}'));
} catch {
  TOOL_ARGS = { a: 2, b: 3 };
}

const endpoint = `${SERVER_URL.replace(/\/$/, '')}/v1/openai/chat/completions`;

const payload = {
  model: MODEL,
  // Stream is intentionally true: workflow should unify this to non-streaming internally
  stream: true,
  messages: [
    { role: 'system', content: '你可以调用工具来完成任务。请优先调用工具，不要直接给出最终答案。' },
    { role: 'user', content: `请调用 ${TOOL_NAME} 工具把 ${TOOL_ARGS.a} 和 ${TOOL_ARGS.b} 相加，然后告诉我结果。` }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: 'add two numbers',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['a', 'b']
        }
      }
    }
  ]
};

(async () => {
  const fetch = await getFetch();
  console.log('\n>>> Sending request to', endpoint);
  console.log('>>> Model:', MODEL);
  console.log('>>> Payload:', JSON.stringify(payload, null, 2));

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('\n❌ Response is not valid JSON. Raw body:\n', text);
    process.exit(1);
  }

  console.log('\n>>> HTTP Status:', resp.status);
  console.log('>>> Response JSON:', JSON.stringify(data, null, 2));

  const payload = data?.data ?? data;
  const choice = payload?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  const finishReason = choice?.finish_reason;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    console.log('\n✅ Detected tool_calls (OpenAI compatible):');
    for (const [i, tc] of toolCalls.entries()) {
      console.log(`  [${i}] id=${tc.id} type=${tc.type} name=${tc.function?.name}`);
      console.log(`      args: ${tc.function?.arguments}`);
    }
    console.log('finish_reason:', finishReason);
  } else {
    console.warn('\n⚠️ No tool_calls detected. The model may not have requested tools for this prompt.');
    console.log('Assistant message content:', choice?.message?.content);
    console.log('finish_reason:', finishReason);
  }
})();
