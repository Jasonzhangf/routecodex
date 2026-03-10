#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = stripUndefined(entry);
    }
    return out;
  }
  return value;
}

async function runCase(format, ctx) {
  process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS = '1';
  const nativeMod = await cacheBustedImport(
    moduleUrl('conversion/hub/semantic-mappers/chat-mapper.js'),
    'native'
  );
  const legacyMod = await cacheBustedImport(
    moduleUrl('conversion/hub/operation-table/semantic-mappers/archive/chat-mapper.archive.js'),
    'legacy'
  );

  const NativeMapper = nativeMod.ChatSemanticMapper;
  const LegacyMapper = legacyMod.ChatSemanticMapper;
  assert.equal(typeof NativeMapper, 'function');
  assert.equal(typeof LegacyMapper, 'function');

  const nativeMapper = new NativeMapper();
  const legacyMapper = new LegacyMapper();

  const nativeTo = stripUndefined(await nativeMapper.toChat(clone(format), clone(ctx)));
  const legacyTo = stripUndefined(await legacyMapper.toChat(clone(format), clone(ctx)));
  assert.deepEqual(nativeTo, legacyTo);

  const nativeFrom = stripUndefined(await nativeMapper.fromChat(clone(nativeTo), clone(ctx)));
  const legacyFrom = stripUndefined(await legacyMapper.fromChat(clone(legacyTo), clone(ctx)));
  assert.deepEqual(nativeFrom, legacyFrom);
}

async function main() {
  const ctx = {
    requestId: 'req-001',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat'
  };

  const format = {
    protocol: 'openai-chat',
    direction: 'request',
    payload: {
      model: 'gpt-test',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system\nline' }] },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'ToolA', arguments: '{}' } }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'apply_patch',
          content: 'Failed to parse function arguments: missing field `input`'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'patch',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      tool_outputs: [
        {
          tool_call_id: 'call_2',
          output: { ok: true },
          name: 'apply_patch'
        }
      ],
      extra_field: 'extra_value'
    }
  };

  await runCase(format, ctx);

  const emptyToolsFormat = clone(format);
  emptyToolsFormat.payload.tools = [];
  emptyToolsFormat.payload.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ];
  emptyToolsFormat.payload.tool_outputs = [];
  await runCase(emptyToolsFormat, ctx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
