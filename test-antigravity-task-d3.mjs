#!/usr/bin/env node
/**
 * Task D3: 多模型回归验证 Antigravity 形态
 * - 按顺序测试一组关键模型
 * - 走 /v1/responses，打印 HTTP 状态和简要响应
 */

import fetch from 'node-fetch';

const ENDPOINT = 'http://127.0.0.1:5555/v1/responses';

const MODELS = [
  'gemini-3-pro-low',
  'gemini-3-pro-high',
  'gemini-3-flash',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking'
];

async function runOnce(model) {
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `现在用模型 ${model} 简单回复一句，说明你是谁。`
          }
        ]
      }
    ],
    stream: false
  };

  console.log('\n' + '='.repeat(80));
  console.log(`🔍 测试模型: ${model}`);
  console.log('请求体:');
  console.log(JSON.stringify(body, null, 2));
  console.log('---');

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    console.log(`📥 状态: ${resp.status} ${resp.statusText}`);
    const text = await resp.text();
    console.log('响应片段:');
    console.log(text.slice(0, 400));
  } catch (err) {
    console.error(`❌ 请求失败 (${model}):`, err.message);
  }
}

async function main() {
  console.log('🚀 Task D3 多模型回归开始...');
  for (const model of MODELS) {
    // eslint-disable-next-line no-await-in-loop
    await runOnce(model);
  }
  console.log('\n✅ Task D3 多模型回归结束');
}

main().catch((err) => {
  console.error('❌ Task D3 运行异常:', err);
  process.exit(1);
});

