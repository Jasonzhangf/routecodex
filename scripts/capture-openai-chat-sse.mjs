#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import OpenAI from 'openai';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      args[k.slice(2)] = v === undefined ? true : v;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const out = args.out || 'openai_chat_capture.sse';
const model = args.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const prompt = args.prompt || 'Hello, world';
const toolsFile = args.tools || '';
const system = args.system || '';

const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY env');
  process.exit(1);
}

const client = new OpenAI({ apiKey });

const messages = [];
if (system && String(system).trim()) messages.push({ role: 'system', content: String(system) });
messages.push({ role: 'user', content: String(prompt) });

let tools = undefined;
if (toolsFile) {
  try {
    tools = JSON.parse(fs.readFileSync(path.resolve(toolsFile), 'utf-8'));
  } catch (e) {
    console.warn('Failed to read tools file:', e.message);
  }
}

const req = { model, messages, stream: true };
if (tools && Array.isArray(tools)) req.tools = tools;

console.log('[capture] request:', { model, messagesCount: messages.length, hasTools: !!tools });
const stream = await client.chat.completions.create(req);

const ws = fs.createWriteStream(out, 'utf-8');
for await (const chunk of stream) {
  ws.write('data: ' + JSON.stringify(chunk) + '\n\n');
}
ws.write('data: [DONE]\n\n');
ws.end();
console.log('[capture] saved to', out);

