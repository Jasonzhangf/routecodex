#!/usr/bin/env node
/**
 * Regression: Antigravity requests must include tool schemas (Gemini functionDeclarations)
 * so upstream can emit structured functionCall/functionResponse parts instead of textual tool markup.
 */

import { GeminiSemanticMapper } from '../../dist/conversion/hub/semantic-mappers/gemini-mapper.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function buildPayloadFromChat(chat, adapterContext) {
  const mapper = new GeminiSemanticMapper();
  const envelope = await mapper.fromChat(chat, adapterContext);
  return envelope.payload;
}

async function main() {
  const chat = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'say hi' }] }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Runs a command.',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      }
    ],
    toolOutputs: undefined,
    parameters: {
      model: 'claude-sonnet-4-5-thinking'
    },
    metadata: {
      systemInstructions: [],
      context: {
        requestId: 'req_matrix_antigravity_tools_downlink',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'gemini-chat',
        providerId: 'antigravity.matrix.claude-sonnet-4-5-thinking',
        profileId: 'antigravity.matrix.claude-sonnet-4-5-thinking',
        routeId: 'thinking',
        streamingHint: 'auto',
        toolCallIdStyle: 'fc'
      }
    }
  };

  const adapterContext = chat.metadata.context;
  const payload = await buildPayloadFromChat(chat, adapterContext);

  const tools = payload && typeof payload === 'object' ? payload.tools : undefined;
  assert(Array.isArray(tools) && tools.length > 0, 'expected request.tools to be present for antigravity');

  const first = tools[0];
  assert(first && typeof first === 'object', 'expected tools[0] to be an object');

  const decls = first.functionDeclarations;
  assert(Array.isArray(decls) && decls.length > 0, 'expected tools[0].functionDeclarations to be present');

  const names = decls.map((d) => (d && typeof d === 'object' ? d.name : undefined)).filter(Boolean);
  assert(names.includes('exec_command'), `expected functionDeclarations to include exec_command, got: ${JSON.stringify(names)}`);

  console.log('✅ antigravity tool schema downlink passed');
}

main().catch((err) => {
  console.error('❌ antigravity tool schema downlink failed:', err && err.message ? err.message : err);
  process.exit(1);
});

