#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist', 'conversion');
const hubRoot = path.join(distRoot, 'hub');

const { createProtocolPlans } = await import(pathToFileURL(path.join(hubRoot, 'registry.js')).href);
const { runInboundPipeline } = await import(pathToFileURL(path.join(hubRoot, 'pipelines', 'inbound.js')).href);
const { runOutboundPipeline } = await import(pathToFileURL(path.join(hubRoot, 'pipelines', 'outbound.js')).href);

const SAMPLE_BASE =
  process.env.CODEX_SAMPLES_DIR || path.join(os.homedir(), '.routecodex', 'codex-samples');

const PROTOCOLS = [
  {
    name: 'openai-chat',
    providerProtocol: 'openai-chat',
    endpoint: '/v1/chat/completions',
    locateSample: () => loadLatestSample('openai-chat', '_provider-request.json')
  },
  {
    name: 'openai-responses',
    providerProtocol: 'openai-responses',
    endpoint: '/v1/responses',
    locateSample: () => loadLatestSample('openai-responses', '_provider-request.json')
  },
  {
    name: 'anthropic-messages',
    providerProtocol: 'anthropic-messages',
    endpoint: '/v1/messages',
    locateSample: () =>
      loadLatestSample('anthropic-messages', '_client-request.json') ||
      loadLatestSample('anthropic-messages', '_provider-request.json')
  },
  {
    name: 'gemini-chat',
    providerProtocol: 'gemini-chat',
    endpoint: '/v1/models:generateContent',
    locateSample: () => loadStaticSample(path.join(projectRoot, 'tests', 'hub', 'fixtures', 'gemini-request.json'))
  }
];

function loadStaticSample(file) {
  const buf = fs.readFileSync(file, 'utf-8');
  return { file, payload: JSON.parse(buf) };
}

function loadLatestSample(subdir, suffix) {
  const dir = path.join(SAMPLE_BASE, subdir);
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name));
  if (!entries.length) return null;
  const ordered = entries
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);
  for (const file of ordered) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const payload = extractPayload(doc);
      if (!payload) continue;
      return { file, payload };
    } catch {
      continue;
    }
  }
  return null;
}

function extractPayload(doc) {
  if (!doc) return undefined;
  if (doc.data?.body?.body && typeof doc.data.body.body === 'object') return doc.data.body.body;
  if (doc.data?.body?.data && typeof doc.data.body.data === 'object') return doc.data.body.data;
  if (doc.data?.body && typeof doc.data.body === 'object') return doc.data.body;
  if (typeof doc.body === 'object') return doc.body;
  return doc;
}

function diffJson(expected, actual, prefix = '') {
  if (Object.is(expected, actual)) return [];
  const pathLabel = prefix || '<root>';
  if (typeof expected !== typeof actual) {
    return [{ path: pathLabel, expected, actual }];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    const diffs = [];
    for (let i = 0; i < max; i += 1) {
      if (i >= expected.length) {
        diffs.push({ path: `${pathLabel}[${i}]`, expected: undefined, actual: actual[i] });
        continue;
      }
      if (i >= actual.length) {
        diffs.push({ path: `${pathLabel}[${i}]`, expected: expected[i], actual: undefined });
        continue;
      }
      diffs.push(...diffJson(expected[i], actual[i], `${pathLabel}[${i}]`));
    }
    return diffs.filter(Boolean);
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const diffs = [];
    for (const key of keys) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (!(key in actual)) {
        diffs.push({ path: next, expected: expected[key], actual: undefined });
        continue;
      }
      if (!(key in expected)) {
        diffs.push({ path: next, expected: undefined, actual: actual[key] });
        continue;
      }
      diffs.push(...diffJson(expected[key], actual[key], next));
    }
    return diffs.filter(Boolean);
  }
  return [{ path: pathLabel, expected, actual }];
}

async function runEquivalence(protocol) {
  const sample = protocol.locateSample();
  assert.ok(sample, `未找到 ${protocol.name} 的样本`);
  const { payload } = sample;
  assert.ok(payload && typeof payload === 'object', `${protocol.name} 样本无效`);
  const { inbound, outbound } = createProtocolPlans(protocol.providerProtocol);
  const context = {
    requestId: `hub-equivalence-${protocol.name}`,
    entryEndpoint: protocol.endpoint,
    providerProtocol: protocol.providerProtocol
  };
  const inboundEnvelope = await runInboundPipeline({
    rawRequest: payload,
    context,
    plan: inbound
  });
  const outboundPayload = await runOutboundPipeline({
    chat: inboundEnvelope,
    context,
    plan: outbound
  });
  const expected = sanitizeProtocolPayload(protocol.name, pruneUndefined(payload));
  const actual = sanitizeProtocolPayload(protocol.name, pruneUndefined(outboundPayload));
  const differences = diffJson(expected, actual);
  if (differences.length) {
    console.error(`❌ ${protocol.name} roundtrip diff (${sample.file}):`);
    differences.slice(0, 10).forEach((entry) => {
      console.error(`  • ${entry.path}:`, 'expected =', entry.expected, '| actual =', entry.actual);
    });
    if (differences.length > 10) {
      console.error(`  ... 共 ${differences.length} 处差异`);
    }
    throw new Error(`${protocol.name} roundtrip mismatch`);
  }
  console.log(`✅ ${protocol.name} roundtrip matches (${sample.file})`);
}

function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry));
  }
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

function sanitizeProtocolPayload(protocolName, payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (protocolName === 'openai-responses') {
    if (payload.metadata) {
      delete payload.metadata;
    }
    if (Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool) => {
        if (!tool || typeof tool !== 'object') {
          return tool;
        }
        const clone = { ...tool };
        if ('function' in clone) {
          delete clone.function;
        }
        return clone;
      });
    }
  } else if (protocolName === 'anthropic-messages') {
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) => {
        if (!message || typeof message !== 'object') {
          return message;
        }
        if (!Array.isArray(message.content)) {
          return message;
        }
        const normalizedContent = [];
        for (const part of message.content) {
          if (!part || typeof part !== 'object') {
            continue;
          }
          if (part.type === 'tool_use') {
            continue;
          }
          if (part.type === 'tool_result') {
            const clone = { ...part };
            if (Array.isArray(clone.content)) {
              clone.content = clone.content
                .map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
                .join('');
            }
            normalizedContent.push(clone);
            continue;
          }
          normalizedContent.push(part);
        }
        message.content = normalizedContent.length ? normalizedContent : '';
        return message;
      });
    }
  }
  return payload;
}

async function main() {
  for (const protocol of PROTOCOLS) {
    await runEquivalence(protocol);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
