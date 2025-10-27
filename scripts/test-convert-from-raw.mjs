import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadCodec() {
  const modPath = path.resolve('dist/modules/pipeline/modules/llmswitch/conversion/codecs/openai-openai-codec.js');
  return await import(pathToFileURL(modPath).href);
}

async function main() {
  const rid = process.argv[2];
  if (!rid) { console.error('usage: node scripts/test-convert-from-raw.mjs <requestId>'); process.exit(1); }
  const base = path.join(process.env.HOME || '', '.routecodex', 'codex-samples', 'chat-replay');
  const rawFile = path.join(base, `raw-request_${rid}.json`);
  const rawText = await fs.readFile(rawFile, 'utf-8');
  const raw = JSON.parse(rawText);
  const body = raw.body || {};
  const { OpenAIOpenAIConversionCodec } = await loadCodec();
  const codec = new OpenAIOpenAIConversionCodec({ logger: { logModule(){}, logTransformation(){} }, errorHandlingCenter: {}, debugCenter: {} });
  await codec.initialize?.();
  const profile = { id: 'p', incomingProtocol: 'openai', outgoingProtocol: 'openai' };
  const context = { requestId: rid, endpoint: raw.url, entryEndpoint: '/v1/chat/completions', metadata: {} };
  const out = await codec.convertRequest(body, profile, context);
  const lastAssist = (out.messages||[]).filter(m => m.role==='assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).slice(-1)[0];
  const argsStr = lastAssist?.tool_calls?.[0]?.function?.arguments || '{}';
  let parsed; try { parsed = JSON.parse(argsStr); } catch { parsed = {}; }
  console.log(JSON.stringify({ argv: parsed?.command, args: parsed }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

