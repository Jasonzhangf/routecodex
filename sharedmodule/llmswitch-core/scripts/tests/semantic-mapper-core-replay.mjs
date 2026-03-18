#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function loadFixtureBody(relPath) {
  const json = loadJson(relPath);
  return json?.data?.body ?? json;
}

async function main() {
  const [{ ResponsesSemanticMapper }, { AnthropicSemanticMapper }, { GeminiSemanticMapper }] = await Promise.all([
    import(moduleUrl('conversion/hub/operation-table/semantic-mappers/responses-mapper.js')),
    import(moduleUrl('conversion/hub/operation-table/semantic-mappers/anthropic-mapper.js')),
    import(moduleUrl('conversion/hub/operation-table/semantic-mappers/gemini-mapper.js'))
  ]);

  const responsesMapper = new ResponsesSemanticMapper();
  const anthropicMapper = new AnthropicSemanticMapper();
  const geminiMapper = new GeminiSemanticMapper();

  {
    const payload = loadFixtureBody('tests/fixtures/codex-samples/openai-responses/sample_provider-request.json');
    const ctx = {
      requestId: 'semantic-core-responses',
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses'
    };
    const chat = await responsesMapper.toChat({ protocol: 'openai-responses', direction: 'request', payload }, ctx);
    assert.equal(chat.parameters?.model, 'gpt-5.1-codex');
    assert.equal(chat.parameters?.parallel_tool_calls, false);
    assert.equal(chat.messages.length, 4);
    assert.equal(chat.tools?.length, 1);
    assert.equal(chat.messages[0]?.role, 'system');
    assert.equal(chat.messages[0]?.content, 'You are Codex. Generate a plan and call tools when necessary.');
    assert.equal(chat.messages.at(-1)?.role, 'tool');
    assert.equal(chat.messages.at(-1)?.tool_call_id, 'fc_readme');
    assert.equal(typeof chat.semantics?.responses, 'object');

    const format = await responsesMapper.fromChat(chat, ctx);
    assert.equal(format.protocol, 'openai-responses');
    assert.equal(format.direction, 'response');
    assert.equal(format.payload.model, 'gpt-5.1-codex');
    assert.equal(format.payload.parallel_tool_calls, false);
    assert.equal(format.payload.instructions, 'You are Codex. Generate a plan and call tools when necessary.');
    assert.equal(Array.isArray(format.payload.input), true);
    assert.equal(format.payload.input.length, 3);
    assert.equal(format.payload.input[1]?.type, 'function_call');
    assert.equal(format.payload.input[2]?.type, 'function_call_output');
    assert.equal(format.payload.metadata?.context?.requestId, 'semantic-core-responses');
  }

  {
    const payload = loadFixtureBody('tests/fixtures/codex-samples/anthropic-messages/sample_provider-request.json');
    const ctx = {
      requestId: 'semantic-core-anthropic',
      providerProtocol: 'anthropic-messages',
      entryEndpoint: '/v1/messages'
    };
    const chat = await anthropicMapper.toChat({ protocol: 'anthropic-messages', direction: 'request', payload }, ctx);
    assert.equal(chat.parameters?.model, 'claude-3-5-sonnet-20241022');
    assert.equal(chat.parameters?.max_tokens, 256);
    assert.equal(chat.messages.length, 3);
    assert.equal(chat.tools?.length, 1);
    assert.equal(chat.toolOutputs?.length, 1);
    assert.equal(chat.messages[0]?.role, 'user');
    assert.equal(chat.messages.at(-1)?.role, 'tool');
    assert.equal(chat.messages.at(-1)?.tool_call_id, 'toolu_focus');

    const format = await anthropicMapper.fromChat(chat, ctx);
    assert.equal(format.protocol, 'anthropic-messages');
    assert.equal(format.direction, 'response');
    assert.equal(format.payload.model, 'claude-3-5-sonnet-20241022');
    assert.equal(Array.isArray(format.payload.messages), true);
    assert.equal(format.payload.messages.length, 3);
    assert.equal(format.payload.messages[1]?.content?.[0]?.type, 'tool_use');
    assert.equal(format.payload.messages[1]?.content?.[0]?.id, 'toolu_focus');
    assert.equal(format.payload.messages[2]?.content?.[0]?.type, 'tool_result');
    assert.equal(format.payload.messages[2]?.content?.[0]?.tool_use_id, 'toolu_focus');
  }

  {
    const payload = loadJson('tests/hub/fixtures/gemini-request.json');
    const ctx = {
      requestId: 'semantic-core-gemini',
      providerProtocol: 'gemini-chat',
      entryEndpoint: '/v1beta/models/test:generateContent'
    };
    const chat = await geminiMapper.toChat({ protocol: 'gemini-chat', direction: 'request', payload }, ctx);
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0]?.role, 'user');
    assert.equal(chat.tools?.length, 1);
    assert.equal(chat.parameters?.model, 'gemini-1.5-pro');
    assert.equal(chat.parameters?.temperature, 0.2);
    assert.equal(chat.parameters?.max_output_tokens, 256);

    chat.parameters = { ...(chat.parameters ?? {}), model: 'gemini-1.5-pro' };
    const format = await geminiMapper.fromChat(chat, ctx);
    assert.equal(format.protocol, 'gemini-chat');
    assert.equal(format.direction, 'response');
    assert.equal(format.payload.model, 'gemini-1.5-pro');
    assert.equal(Array.isArray(format.payload.contents), true);
    assert.equal(format.payload.contents[0]?.role, 'user');
    assert.equal(Array.isArray(format.payload.tools), true);
    assert.equal(format.payload.tools[0]?.functionDeclarations?.[0]?.name, 'exec_command');

    const antigravityFormat = await geminiMapper.fromChat(
      {
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { model: 'claude-sonnet-4-5-thinking', temperature: 0.2 },
        metadata: { context: { ...ctx, providerId: 'antigravity.any' } }
      },
      { ...ctx, providerId: 'antigravity.any' }
    );
    assert.equal(typeof antigravityFormat.payload.systemInstruction?.parts?.[0]?.text, 'string');
    assert.match(antigravityFormat.payload.systemInstruction.parts[0].text, /You are Antigravity/);
    assert.equal(Array.isArray(antigravityFormat.payload.safetySettings), true);
    assert.equal(antigravityFormat.payload.generationConfig?.maxOutputTokens, 64000);
    assert.equal(antigravityFormat.payload.generationConfig?.topK, 64);
    assert.equal(typeof antigravityFormat.payload.metadata?.antigravitySessionId, 'string');

    const geminiCliFormat = await geminiMapper.fromChat(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'request_user_input',
              description: 'Ask the user a question and return their answer.',
              parameters: {
                type: 'object',
                properties: { questions: { type: 'array' } },
                required: ['questions']
              }
            }
          }
        ],
        parameters: { model: 'models/gemini-pro', tool_choice: 'auto' },
        metadata: { context: { ...ctx, providerId: 'gemini-cli.any' } }
      },
      { ...ctx, providerId: 'gemini-cli.any' }
    );
    assert.equal(Array.isArray(geminiCliFormat.payload.tools), true);
    assert.equal(geminiCliFormat.payload.tools[0]?.functionDeclarations?.[0]?.name, 'request_user_input');
  }

  console.log('✅ semantic-mapper core replay passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
