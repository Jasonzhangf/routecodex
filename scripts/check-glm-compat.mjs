#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const rawPath = process.argv[2] || path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat', 'req_1762264740299_ifnozpv3l_raw-request.json');
  const outDir = process.argv[3] || path.join(process.cwd(), 'test-results', 'glm-compat');
  await fs.mkdir(outDir, { recursive: true });
  const rawTxt = await fs.readFile(rawPath, 'utf-8');
  const raw = JSON.parse(rawTxt);
  const body = raw.body || raw;

  // Step1: convert to OpenAI-OpenAI via codec (so we get normalized chat shape)
  const openaiCodecUrl = pathToFileURL(path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist', 'v2', 'conversion', 'codecs', 'openai-openai-codec.js')).href;
  const { OpenAIOpenAIConversionCodec } = await import(openaiCodecUrl);
  const codec = new OpenAIOpenAIConversionCodec({});
  const profile = { outgoingProtocol: 'openai-chat' };
  const ctx = { requestId: 'check_glm_' + Date.now(), endpoint: '/v1/chat/completions', entryEndpoint: '/v1/chat/completions', metadata: {} };
  const openaiReq = await codec.convertRequest(body, profile, ctx);

  // Step2: run GLM compatibility incoming path on the normalized request
  const glmCompatUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'modules', 'pipeline', 'modules', 'compatibility', 'glm', 'glm-compatibility.js')).href;
  const { GLMCompatibility } = await import(glmCompatUrl);
  const compat = new GLMCompatibility({ logger: { logModule: ()=>{}, logError: ()=>{} } });
  await compat.initialize();
  const out = await compat.processIncoming(openaiReq, { requestId: ctx.requestId, entryEndpoint: '/v1/chat/completions' });

  const outFile = path.join(outDir, 'glm_compat_request.json');
  await fs.writeFile(outFile, JSON.stringify(out, null, 2), 'utf-8');
  console.log('GLM compat request written:', outFile);

  // Quick assertions printed to stdout
  const tools = Array.isArray(out.tools) ? out.tools : [];
  const shell = tools.find(t => t?.function?.name === 'shell');
  const cmdSchema = shell?.function?.parameters?.properties?.command;
  console.log('[schema] shell.command oneOf:', !!(cmdSchema && cmdSchema.oneOf));
  console.log('[schema] shell.command.type:', cmdSchema?.type);
  const msgs = Array.isArray(out.messages) ? out.messages : [];
  const toolCalls = msgs.filter(m => Array.isArray(m?.tool_calls)).flatMap(m => m.tool_calls);
  const argTypeSet = new Set(toolCalls.map(tc => typeof tc?.function?.arguments));
  console.log('[messages] function.arguments types:', Array.from(argTypeSet).join(','));
}

main().catch(err => { console.error(err); process.exit(1); });

