#!/usr/bin/env node
// Replay Anthropic SSE events from a provider-out OpenAI response to verify finish_reason mapping and tool_use sequencing.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/replay-openai-events.mjs <provider-out-openai.json>');
  process.exit(1);
}

const abs = path.resolve(file);
const payload = JSON.parse(fs.readFileSync(abs, 'utf-8'));

const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
if (!fs.existsSync(distPath)) {
  console.error('Build missing. Run: npm run build');
  process.exit(1);
}
const { AnthropicOpenAIConverter } = await import(url.pathToFileURL(distPath).href);
const toEvents = AnthropicOpenAIConverter.toAnthropicEventsFromOpenAI;
const events = toEvents ? toEvents(payload) : [];

console.log(JSON.stringify({
  sample: path.basename(abs),
  eventsCount: events.length,
  first5: events.slice(0,5),
  last5: events.slice(-5)
}, null, 2));

