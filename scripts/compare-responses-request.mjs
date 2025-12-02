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

function extractPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
  if (data.body && typeof data.body === 'object') {
    if (data.body.body && typeof data.body.body === 'object') {
      return data.body.body;
    }
    return data.body;
  }
  if (snapshot.body && typeof snapshot.body === 'object') {
    return snapshot.body;
  }
  return data;
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

  console.log(`Client snapshot: ${clientPath}`);
  console.log(`Provider snapshot: ${providerPath}`);

  const clientPayload = extractPayload(clientSnapshot);
  const providerPayload = extractPayload(providerSnapshot);

  listCounts('Client', clientPayload);
  listCounts('Provider', providerPayload);

  const diffs = diffPayloads(pruneUndefined(clientPayload), pruneUndefined(providerPayload));
  if (!diffs.length) {
    console.log('\nPayload diff: none (exact match)');
  } else {
    console.log('\nPayload diff (first 50):');
    diffs.slice(0, 50).forEach((entry) => {
      console.log(`  - ${entry.path}: client=${summarizeValue(entry.expected)} | provider=${summarizeValue(entry.actual)}`);
    });
    if (diffs.length > 50) {
      console.log(`  ... ${diffs.length - 50} more differences`);
    }
  }
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = pruneUndefined(entry);
    }
    return out;
  }
  return value;
}

function diffPayloads(expected, actual, path = '<root>') {
  if (Object.is(expected, actual)) return [];
  if (typeof expected !== typeof actual) {
    return [{ path, expected, actual }];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    const diffs = [];
    for (let i = 0; i < max; i += 1) {
      if (i >= expected.length) {
        diffs.push({ path: `${path}[${i}]`, expected: undefined, actual: actual[i] });
        continue;
      }
      if (i >= actual.length) {
        diffs.push({ path: `${path}[${i}]`, expected: expected[i], actual: undefined });
        continue;
      }
      diffs.push(...diffPayloads(expected[i], actual[i], `${path}[${i}]`));
    }
    return diffs;
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const diffs = [];
    for (const key of keys) {
      const next = path === '<root>' ? key : `${path}.${key}`;
      if (!(key in actual)) {
        diffs.push({ path: next, expected: expected[key], actual: undefined });
        continue;
      }
      if (!(key in expected)) {
        diffs.push({ path: next, expected: undefined, actual: actual[key] });
        continue;
      }
      diffs.push(...diffPayloads(expected[key], actual[key], next));
    }
    return diffs;
  }
  return [{ path, expected, actual }];
}

main();
