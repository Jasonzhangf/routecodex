#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');
const codecModule = path.join(projectRoot, 'dist', 'conversion', 'codecs', 'anthropic-openai-codec.js');

const { buildOpenAIChatFromAnthropic, buildAnthropicRequestFromOpenAIChat } = await import(
  pathToFileURL(codecModule).href
);

const chatToAnthropicDisabled = buildAnthropicRequestFromOpenAIChat({
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  parallel_tool_calls: false
});
assert.equal(chatToAnthropicDisabled.disable_parallel_tool_use, true);
assert.equal('parallel_tool_calls' in chatToAnthropicDisabled, false);

const chatToAnthropicEnabled = buildAnthropicRequestFromOpenAIChat({
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  parallel_tool_calls: true
});
assert.equal(chatToAnthropicEnabled.disable_parallel_tool_use, false);

const anthropicToChatDisabled = buildOpenAIChatFromAnthropic({
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  disable_parallel_tool_use: true
});
assert.equal(anthropicToChatDisabled.parallel_tool_calls, false);

const anthropicToChatEnabled = buildOpenAIChatFromAnthropic({
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  disable_parallel_tool_use: false
});
assert.equal(anthropicToChatEnabled.parallel_tool_calls, true);

console.log('ok anthropic parallel_tool_calls mapping');
