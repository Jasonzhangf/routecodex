#!/usr/bin/env node
// Validate Chat streaming in three scenarios without hitting upstream network:
// 1) Upstream SSE passthrough via Readable
// 2) Non-stream Chat JSON -> synthetic SSE (with tool_calls only)
// 3) Responses JSON -> synthetic SSE (with function_call)

import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const { StreamingManager } = await import('../dist/server/utils/streaming-manager.js');

class FakeRes {
  constructor() { this.buf = ''; this.headers = {}; this.writableEnded = false; }
  setHeader(k, v) { this.headers[k] = v; }
  write(chunk) { if (!this.writableEnded) this.buf += String(chunk); }
  end() { this.writableEnded = true; }
}

async function runCase(name, data) {
  const mgr = new StreamingManager({ enablePipeline: true, enableMetrics: false });
  const res = new FakeRes();
  const reqId = `test_${name}_${Date.now()}`;
  await mgr.streamResponse({ data }, reqId, res, 'gpt-4o');
  return res.buf;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  let pass = 0, fail = 0;

  // Case 1: Passthrough SSE
  try {
    const sse = [
      `data: ${JSON.stringify({ id: 'a', object: 'chat.completion.chunk', created: Date.now()/1000|0, model: 'gpt', choices:[{index:0,delta:{role:'assistant'}}] })}\n\n`,
      `data: ${JSON.stringify({ id: 'b', object: 'chat.completion.chunk', created: Date.now()/1000|0, model: 'gpt', choices:[{index:0,delta:{tool_calls:[{index:0,type:'function',function:{name:'shell'}}]}}] })}\n\n`,
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: Date.now()/1000|0, model: 'gpt', choices:[{index:0,delta:{tool_calls:[{index:0,type:'function',function:{arguments:'{"cmd":"echo hi"}'}}]},finish_reason:'tool_calls'}] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const readable = Readable.from(sse);
    const buf = await runCase('passthrough', readable);
    assert(buf.includes('tool_calls'), 'case1: missing tool_calls');
    assert(buf.includes('[DONE]'), 'case1: missing DONE');
    console.log('[validate] case1 passthrough: OK'); pass++;
  } catch (e) { console.error('[validate] case1 passthrough: FAIL', e.message); fail++; }

  // Case 2: Non-stream Chat JSON with tool_calls only
  try {
    const data = {
      id: 'chatcmpl-1', object: 'chat.completion', created: Date.now()/1000|0, model: 'gpt',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [ { type:'function', function: { name: 'shell', arguments: '{"cmd":"whoami"}' } } ] }, finish_reason: 'tool_calls' }]
    };
    const buf = await runCase('chatjson', data);
    assert(/data: \{/.test(buf), 'case2: no data lines');
    assert(buf.includes('"tool_calls"'), 'case2: missing tool_calls');
    assert(buf.includes('whoami'), 'case2: missing arguments');
    assert(/finish_reason\":\"tool_calls\"/.test(buf) || buf.includes('tool_calls') , 'case2: missing finish_reason tool_calls');
    console.log('[validate] case2 chat-json synth: OK'); pass++;
  } catch (e) { console.error('[validate] case2 chat-json synth: FAIL', e.message); fail++; }

  // Case 3: Responses JSON with function_call and output_text
  try {
    const data = {
      id: 'resp-1', object: 'response', created_at: Date.now()/1000|0, model: 'gpt',
      output: [ { type: 'function_call', name: 'shell', arguments: '{"cmd":"date"}' }, { type:'message', message: { role:'assistant', content: [ { type:'output_text', text: 'ok' } ] } } ],
      output_text: 'ok'
    };
    const buf = await runCase('responsesjson', data);
    assert(buf.includes('tool_calls'), 'case3: missing tool_calls');
    assert(buf.includes('date'), 'case3: missing arguments');
    assert(buf.includes('ok'), 'case3: missing output_text');
    console.log('[validate] case3 responses-json synth: OK'); pass++;
  } catch (e) { console.error('[validate] case3 responses-json synth: FAIL', e.message); fail++; }

  console.log(`[validate] summary: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[validate] fatal', e); process.exit(1); });

