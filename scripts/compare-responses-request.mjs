#!/usr/bin/env node

/**
 * Compare inbound client payload and outbound provider payload for a given requestId.
 *
 * Usage:
 *   node scripts/compare-responses-request.mjs --id req-v2-xxx --protocol openai-responses
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const protocolFolders = {
  'openai-responses': 'openai-responses',
  'openai-chat': 'openai-chat',
  'anthropic-messages': 'anthropic-messages'
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { protocol: 'openai-responses' };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--id' && args[i + 1]) {
      opts.id = args[++i];
    } else if (token === '--protocol' && args[i + 1]) {
      opts.protocol = args[++i];
    } else if (token === '--client-protocol' && args[i + 1]) {
      opts.clientProtocol = args[++i];
    } else if (token === '--provider-protocol' && args[i + 1]) {
      opts.providerProtocol = args[++i];
    } else if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!opts.id) {
    console.error('Missing --id <requestId>');
    printUsage();
    process.exit(1);
  }
  return opts;
}

function printUsage() {
  console.log('Usage: node scripts/compare-responses-request.mjs --id <requestId> [--protocol ...] [--client-protocol ...] [--provider-protocol ...]');
}

function normalizeRequestId(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid request id');
  }
  const safe = id.startsWith('req_') ? id : `req_${id}`;
  return safe.replace(/[^\w.-]/g, '_');
}

function loadSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Snapshot not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractContainer(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  return snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
}

function unwrapBody(snapshot) {
  const container = extractContainer(snapshot);
  if (!container || typeof container !== 'object') {
    return {};
  }
  return container.body ?? {};
}

function summarizeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (Array.isArray(value)) {
    return `[array length=${value.length}]`;
  }
  if (typeof value === 'object') {
    return `[object keys=${Object.keys(value).length}]`;
  }
  return String(value);
}

function diffObjects(label, a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const diffs = [];
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    diffs.push({ key, client: summarizeValue(av), provider: summarizeValue(bv) });
  }
  if (!diffs.length) {
    console.log(`\n${label}: no differences`);
    return;
  }
  console.log(`\n${label}:`);
  for (const entry of diffs) {
    console.log(`  - ${entry.key}: client=${entry.client} | provider=${entry.provider}`);
  }
}

function listCounts(label, payload) {
  const inputCount = Array.isArray(payload?.input) ? payload.input.length : 0;
  const messageCount = Array.isArray(payload?.messages) ? payload.messages.length : 0;
  const toolCount = Array.isArray(payload?.tools) ? payload.tools.length : 0;
  console.log(
    `${label} counts → input:${inputCount} messages:${messageCount} tools:${toolCount} instructions:${typeof payload?.instructions === 'string'}`
  );
}

function main() {
  const opts = parseArgs();
  const clientProtocol = opts.clientProtocol || opts.protocol;
  const providerProtocol = opts.providerProtocol || opts.protocol;
  const clientFolder = protocolFolders[clientProtocol];
  const providerFolder = protocolFolders[providerProtocol];
  if (!clientFolder) {
    throw new Error(`Unsupported client protocol ${clientProtocol}`);
  }
  if (!providerFolder) {
    throw new Error(`Unsupported provider protocol ${providerProtocol}`);
  }
  const normalizedId = normalizeRequestId(opts.id);
  const root = path.join(os.homedir(), '.routecodex', 'codex-samples');
  const clientPath = path.join(root, clientFolder, `${normalizedId}_client-request.json`);
  const providerPath = path.join(root, providerFolder, `${normalizedId}_provider-request.json`);

  const clientSnapshot = loadSnapshot(clientPath);
  const providerSnapshot = loadSnapshot(providerPath);
  const clientContainer = extractContainer(clientSnapshot);
  const providerContainer = extractContainer(providerSnapshot);

  console.log(`Client snapshot: ${clientPath}`);
  console.log(`Provider snapshot: ${providerPath}`);

  const clientBodyContainer = unwrapBody(clientSnapshot);
  const providerBody = unwrapBody(providerSnapshot);
  const clientPayload = clientBodyContainer?.body ?? clientBodyContainer;
  const clientMeta = clientBodyContainer?.metadata ?? {};

  listCounts('Client', clientPayload);
  listCounts('Provider', providerBody);

  diffObjects('Headers diff', clientContainer.headers || {}, providerContainer.headers || {});
  diffObjects('Payload diff (top-level)', clientPayload || {}, providerBody || {});

  console.log('\nClient metadata:', JSON.stringify(clientMeta, null, 2));
}

main();
