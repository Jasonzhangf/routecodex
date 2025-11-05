#!/usr/bin/env node
// Remove the last assistant message that contains tool_calls from a provider-request.json
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.length < 3) {
  console.error('Usage: remove-last-toolcall.mjs <provider-request.json>');
  process.exit(2);
}

const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf-8');
const j = JSON.parse(raw);
const body = j.body || {};
const messages = Array.isArray(body.messages) ? body.messages.slice() : [];

let idx = -1;
for (let i = messages.length - 1; i >= 0; i--) {
  const m = messages[i];
  if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    idx = i; break;
  }
}

if (idx === -1) {
  console.error('No assistant.tool_calls found');
  process.exit(0);
}

// Remove only the last assistant tool_calls message
messages.splice(idx, 1);

const out = { model: body.model || 'glm-4.5-air', messages, tools: body.tools, stream: false };
console.log(JSON.stringify(out, null, 2));

