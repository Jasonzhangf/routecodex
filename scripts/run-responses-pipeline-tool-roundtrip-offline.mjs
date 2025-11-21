#!/usr/bin/env node
import { Readable } from 'node:stream';
import { PipelineManager } from '../dist/modules/pipeline/index.js';
import { createResponsesSSEStreamFromChatJson } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-responses-sse.ts';
import { aggregateOpenAIResponsesSSEToJSON } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.ts';

function toReadableFromStream(s) { return new Promise((resolve) => { const arr=[]; s.on('data', c => arr.push(String(c))); s.on('end', () => { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(arr.join('')); r.push(null);}); resolve(r); }); }); }
function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }

async function main() {
  const pipelineId = 'offline.responses';
  const managerConfig = { pipelines: [ { id: pipelineId, provider: { type: 'responses' }, modules: { llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } }, workflow: { type: 'streaming-control', config: {} }, compatibility: { type: 'compatibility', config: { moduleType: 'responses-compatibility', providerType: 'responses' } }, provider: { type: 'responses', config: { providerType: 'responses', baseUrl: 'https://api.openai.com/v1', auth: { type: 'apikey', apiKey: 'sk-xxx' }, overrides: { headers: { Accept: 'application/json' }, endpoint: '/responses' } } } } } ] };
  const dummyErrorCenter = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const dummyDebugCenter = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
  const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
  await manager.initialize();

  // 1) synthesize Responses SSE with a tool_call
  const chatJson = { id: 'chatcmpl_TOOL1', model: 'gpt-4o-mini', choices: [ { index: 0, message: { role: 'assistant', content: null, tool_calls: [ { id: 'call_X', type: 'function', function: { name: 'shell_command', arguments: '{"command":"echo hello"}' } } ] } } ] };
  const sse = createResponsesSSEStreamFromChatJson(chatJson, { requestId: 'resp_tool_synth' });
  const r = await toReadableFromStream(sse);
  const json1 = await aggregateOpenAIResponsesSSEToJSON(r);
  if (!json1?.required_action || json1.required_action?.type !== 'submit_tool_outputs') { console.error('synth failed to produce required_action'); process.exit(2); }
  const callId = String(json1.required_action.submit_tool_outputs.tool_calls?.[0]?.id || '');

  // 2) follow-up via pipeline using standard mapped payload
  const follow = { model: String(json1?.model || 'gpt-4o-mini'), input: [ { type: 'tool_result', tool_call_id: callId, output: '[MOCK_TOOL_OUTPUT]' } ], previous_response_id: String(json1?.id || ''), stream: true };
  const req = { data: { ...follow, metadata: { entryEndpoint: '/v1/responses', stream: true } }, route: { providerId: 'offline', modelId: String(follow.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId }, metadata: { entryEndpoint: '/v1/responses', stream: true }, debug: { enabled: false, stages: {} } };
  const out = await manager.processRequest(req);
  const sse2 = out?.data?.__sse_responses;
  if (!sse2) { console.error('no sse2'); process.exit(3); }
  const text2 = await new Promise((resolve) => { const arr=[]; sse2.on('data', c=>arr.push(String(c))); sse2.on('end', ()=> resolve(arr.join(''))); });
  const json2 = await aggregateOpenAIResponsesSSEToJSON(toReadable(String(text2)));
  const hasRA2 = !!json2?.required_action;
  const outText2 = (() => { try { const out = Array.isArray(json2?.output) ? json2.output : []; const msg = out.find(o=>o?.type==='message'); const parts = Array.isArray(msg?.content) ? msg.content : []; const ot = parts.find(p=>p?.type==='output_text'); return String(ot?.text || ''); } catch { return ''; }})();
  console.log('[responses-tool-rt-offline] required_action_2:', hasRA2);
  console.log('[responses-tool-rt-offline] output_text_2.length:', outText2.length);
}

main().catch((e)=>{ console.error(e); process.exit(1); });

