#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

async function main() {
  const [{ ChatSemanticMapper }, { ResponsesSemanticMapper }, { AnthropicSemanticMapper }, { GeminiSemanticMapper }] =
    await Promise.all([
      import(moduleUrl('conversion/hub/semantic-mappers/chat-mapper.js')),
      import(moduleUrl('conversion/hub/semantic-mappers/responses-mapper.js')),
      import(moduleUrl('conversion/hub/semantic-mappers/anthropic-mapper.js')),
      import(moduleUrl('conversion/hub/semantic-mappers/gemini-mapper.js'))
    ]);

  const chatMapper = new ChatSemanticMapper();
  const responsesMapper = new ResponsesSemanticMapper();
  const anthropicMapper = new AnthropicSemanticMapper();
  const geminiMapper = new GeminiSemanticMapper();

  {
    const inbound = await chatMapper.toChat(
      {
        protocol: 'openai-chat',
        direction: 'request',
        payload: {
          model: 'gpt-5.2',
          messages: [
            { role: 'system', content: 'be concise' },
            { role: 'user', content: 'hello semantic mapper' }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'echo_tool',
                parameters: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text']
                }
              }
            }
          ],
          stream: false
        }
      },
      { requestId: 'replay-chat-in', providerProtocol: 'openai-chat', entryEndpoint: '/v1/chat/completions' }
    );
    assert.equal(inbound.messages[0]?.role, 'system');
    assert.equal(inbound.messages[1]?.role, 'user');
    assert.equal(inbound.parameters?.model, 'gpt-5.2');
    assert.equal(Array.isArray(inbound.tools), true);

    const outbound = await chatMapper.fromChat(inbound, {
      requestId: 'replay-chat-out',
      providerProtocol: 'openai-chat',
      entryEndpoint: '/v1/chat/completions'
    });
    assert.equal(outbound.protocol, 'openai-chat');
    assert.equal(outbound.direction, 'response');
    assert.equal(outbound.payload.model, 'gpt-5.2');
    assert.equal(Array.isArray(outbound.payload.messages), true);
  }

  {
    const inbound = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gpt-5.2',
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'summarize this request' }]
            }
          ],
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city']
              }
            }
          ]
        }
      },
      { requestId: 'replay-responses-in', providerProtocol: 'openai-responses', entryEndpoint: '/v1/responses' }
    );
    assert.equal(inbound.parameters?.model, 'gpt-5.2');
    assert.equal(Array.isArray(inbound.messages), true);
    assert.equal(Array.isArray(inbound.tools), true);
    assert.equal(typeof inbound.semantics?.responses, 'object');

    const outbound = await responsesMapper.fromChat(inbound, {
      requestId: 'replay-responses-out',
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses'
    });
    assert.equal(outbound.protocol, 'openai-responses');
    assert.equal(outbound.direction, 'response');
    assert.equal(outbound.payload.model, 'gpt-5.2');
    assert.equal(Array.isArray(outbound.payload.input), true);
  }

  {
    const inbound = await anthropicMapper.toChat(
      {
        protocol: 'anthropic-messages',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'hello anthropic mapper' }],
          tools: [
            {
              name: 'lookup_docs',
              description: 'Lookup docs',
              input_schema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
              }
            }
          ],
          max_tokens: 512
        }
      },
      {
        requestId: 'replay-anthropic-in',
        providerProtocol: 'anthropic-messages',
        entryEndpoint: '/v1/messages'
      }
    );
    assert.equal(inbound.parameters?.model, 'claude-sonnet-4-5');
    assert.equal(Array.isArray(inbound.messages), true);
    assert.equal(inbound.messages.at(-1)?.role, 'user');
    assert.equal(Array.isArray(inbound.tools), true);

    const outbound = await anthropicMapper.fromChat(inbound, {
      requestId: 'replay-anthropic-out',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    });
    assert.equal(outbound.protocol, 'anthropic-messages');
    assert.equal(outbound.direction, 'response');
    assert.equal(outbound.payload.model, 'claude-sonnet-4-5');
    assert.equal(Array.isArray(outbound.payload.messages), true);
  }

  {
    const inbound = await geminiMapper.toChat(
      {
        protocol: 'gemini-chat',
        direction: 'request',
        payload: {
          systemInstruction: { parts: [{ text: 'You are a helpful Gemini-compatible assistant.' }] },
          contents: [{ role: 'user', parts: [{ text: 'hello gemini mapper' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'search_docs',
                  description: 'Search docs',
                  parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query']
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 256
          }
        }
      },
      { requestId: 'replay-gemini-in', providerProtocol: 'gemini-chat', entryEndpoint: '/v1beta/models/test:generateContent' }
    );
    assert.equal(Array.isArray(inbound.messages), true);
    assert.equal(inbound.messages.at(-1)?.role, 'user');
    assert.equal(Array.isArray(inbound.tools), true);
    assert.equal(inbound.parameters?.temperature, 0.2);

    inbound.parameters = { ...(inbound.parameters ?? {}), model: 'gemini-2.5-pro' };
    const outbound = await geminiMapper.fromChat(inbound, {
      requestId: 'replay-gemini-out',
      providerProtocol: 'gemini-chat',
      entryEndpoint: '/v1beta/models/test:generateContent'
    });
    assert.equal(outbound.protocol, 'gemini-chat');
    assert.equal(outbound.direction, 'response');
    assert.equal(Array.isArray(outbound.payload.contents), true);
    assert.equal(typeof outbound.payload.generationConfig, 'object');
  }

  console.log('✅ semantic-mapper public replay passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
