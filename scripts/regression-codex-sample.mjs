#!/usr/bin/env node
// Minimal regression over latest Codex sample captured under ~/.routecodex/codex-samples
// - Loads latest pipeline-in-anth_*.json
// - Runs Anthropic->OpenAI request transform
// - Synthesizes an OpenAI-style non-stream response with tool_calls
// - Runs toAnthropicEventsFromOpenAI to verify streaming event conversion and stop_reason semantics

import fs from 'node:fs/promises';
import path from 'node:path';

async function findLatestSample(dir, prefix) {
  const files = await fs.readdir(dir).catch(() => []);
  const cand = files
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => ({ f, ts: extractTs(f) }))
    .sort((a, b) => b.ts - a.ts);
  return cand.length ? path.join(dir, cand[0].f) : null;
}

function extractTs(name) {
  const m = name.match(/_(\d{10,})/);
  return m ? Number(m[1]) : 0;
}

function summary(label, obj) {
  return `${label}: ${JSON.stringify(obj)}`;
}

async function main() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const samplesDir = path.join(home, '.routecodex', 'codex-samples');
  const latestIn = await findLatestSample(samplesDir, 'pipeline-in-anth_');
  if (!latestIn) {
    console.error('No pipeline-in-anth_*.json samples found');
    process.exit(2);
  }
  const raw = await fs.readFile(latestIn, 'utf8');
  const sample = JSON.parse(raw);
  const anthropicReq = sample.data || sample;

  // Load converter from built dist
  const { AnthropicOpenAIConverter } = await import('../dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableStreaming: true, enableTools: true, conversionMappings: {} } }, { logger: { logModule() {}, logTransformation() {} } });
  await conv.initialize();

  const openaiReq = await conv.transformRequest({ data: anthropicReq, route: { providerId: 'test', modelId: anthropicReq.model || 'unknown', requestId: 'test', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } });
  const outPayload = openaiReq && openaiReq.data ? openaiReq.data : openaiReq;

  const hasOAtools = Array.isArray(outPayload.tools) && outPayload.tools.some(t => t && t.type === 'function' && t.function);
  const msgCount = Array.isArray(outPayload.messages) ? outPayload.messages.length : 0;
  console.log(summary('request_transform', { model: outPayload.model, msgCount, hasOAtools }));

  // Synthesize an OpenAI response containing tool_calls + text
  const response = {
    id: `chatcmpl_${Date.now()}`,
    model: outPayload.model || 'unknown',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok',
          tool_calls: [
            {
              id: `call_${Math.random().toString(36).slice(2,8)}`,
              type: 'function',
              function: { name: 'Read', arguments: JSON.stringify({ file_path: '/etc/hosts' }) },
            }
          ],
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  const events = AnthropicOpenAIConverter.toAnthropicEventsFromOpenAI(response);
  const types = events.map(e => e.event);
  const delta = events.find(e => e.event === 'message_delta');
  const stopReason = delta && delta.data && delta.data.delta ? delta.data.delta.stop_reason : null;
  console.log(summary('events', { count: events.length, seq: types }));
  console.log(summary('stop_reason', { stopReason }));

  // Basic regress assertions: tool_use stop_reason must be set; content blocks should exist
  const hasToolUseStart = events.some(e => e.event === 'content_block_start' && e.data && e.data.content_block && e.data.content_block.type === 'tool_use');
  const hasTextBlock = events.some(e => e.event === 'content_block_start' && e.data && e.data.content_block && e.data.content_block.type === 'text');
  const passed = hasToolUseStart && hasTextBlock && stopReason === 'tool_use';
  console.log(summary('regression', { passed, hasToolUseStart, hasTextBlock, stopReason }));
  process.exit(passed ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });

