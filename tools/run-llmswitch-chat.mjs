#!/usr/bin/env node
// Quick llmswitch-core Chat filter runner: runStandardChatRequestFilters without starting server.
// Usage:
//   node tools/run-llmswitch-chat.mjs path/to/chat-request.json [/v1/chat|/v1/messages|/v1/responses]

import fs from 'fs';
import path from 'path';
import url from 'url';
import { runStandardChatRequestFilters } from '../sharedmodule/llmswitch-core/dist/v2/conversion/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
  const file = process.argv[2];
  const endpoint = process.argv[3] || '/v1/chat/completions';

  if (!file) {
    console.error('Usage: node tools/run-llmswitch-chat.mjs <payload.json> [endpoint]');
    process.exit(1);
  }

  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const txt = fs.readFileSync(abs, 'utf8');
  const raw = JSON.parse(txt);

  // Allow passing either a raw chat body, or a provider-request snapshot with { endpoint, data: { body } }
  let payload = raw;
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && raw.data.body) {
    payload = raw.data.body;
  }

  const requestId = `req_${Date.now()}`;
  const profile = {
    id: 'test-profile',
    incomingProtocol: 'openai-chat',
    outgoingProtocol: 'openai-chat'
  };

  const context = {
    requestId,
    entryEndpoint: endpoint,
    endpoint,
    metadata: {}
  };

  const out = await runStandardChatRequestFilters(payload, profile, context);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch(err => {
  console.error('Error running llmswitch filters:', err);
  process.exit(1);
});
