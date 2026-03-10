#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist', 'conversion');
const hubRoot = path.join(distRoot, 'hub');
const samplesBase = process.env.CODEX_SAMPLES_DIR || path.join(os.homedir(), '.routecodex', 'codex-samples');

const { createProtocolPlans } = await import(pathToFileURL(path.join(hubRoot, 'registry.js')).href);
const { runInboundPipeline } = await import(pathToFileURL(path.join(hubRoot, 'pipelines', 'inbound.js')).href);
const { runOutboundPipeline } = await import(pathToFileURL(path.join(hubRoot, 'pipelines', 'outbound.js')).href);

const geminiFixture = path.join(projectRoot, 'tests', 'hub', 'fixtures', 'gemini-request.json');

const PROTOCOL_SOURCES = {
  'openai-chat': () => loadLatestSample('openai-chat', '_provider-request.json'),
  'openai-responses': () => loadLatestSample('openai-responses', '_provider-request.json'),
  'anthropic-messages': () =>
    loadLatestSample('anthropic-messages', '_client-request.json') ||
    loadLatestSample('anthropic-messages', '_provider-request.json'),
  'gemini-chat': () => ({ file: geminiFixture, payload: loadFixture(geminiFixture) })
};

const CHAINS = [
  ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-chat', 'openai-chat'],
  ['openai-responses', 'anthropic-messages', 'gemini-chat', 'openai-chat', 'openai-responses'],
  ['anthropic-messages', 'gemini-chat', 'openai-responses', 'openai-chat', 'anthropic-messages'],
  ['gemini-chat', 'openai-responses', 'anthropic-messages', 'openai-chat', 'gemini-chat']
];

function sanitizePayload(protocol, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (protocol === 'openai-responses' || protocol === 'anthropic-messages' || protocol === 'openai-chat' || protocol === 'gemini-chat') {
    const clone = JSON.parse(JSON.stringify(payload));
    if (clone.metadata && typeof clone.metadata === 'object') {
      delete clone.metadata.__rcc_tools_field_present;
      delete clone.metadata.__rcc_raw_system;
      if (Object.keys(clone.metadata).length === 0) {
        delete clone.metadata;
      }
    }
    if (protocol === 'openai-chat') {
      delete clone.__rcc_raw_system;
      delete clone.__rcc_provider_metadata;
    }
    return clone;
  }
  return payload;
}

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadLatestSample(subdir, suffix) {
  const dir = path.join(samplesBase, subdir);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const body = extractBody(doc);
      if (!body) continue;
      return { file, payload: body };
    } catch {
      continue;
    }
  }
  return null;
}

function extractBody(doc) {
  if (doc?.data?.body?.body) return doc.data.body.body;
  if (doc?.data?.body?.data) return doc.data.body.data;
  if (doc?.data?.body && typeof doc.data.body === 'object') return doc.data.body;
  if (doc?.body && typeof doc.body === 'object') return doc.body;
  return doc;
}

async function runChain(chain) {
  const start = chain[0];
  const sample = PROTOCOL_SOURCES[start]?.();
  if (!sample) throw new Error(`Missing sample for ${start}`);
  let chat = await convertInbound(sample.payload, start);
  for (let i = 1; i < chain.length; i += 1) {
    const protocol = chain[i];
    const payload = await convertOutbound(chat, protocol);
    chat = await convertInbound(payload, protocol);
  }
  const finalPayload = await convertOutbound(chat, start);
  const sanitizedSample = sanitizePayload(start, sample.payload);
  const sanitizedFinal = sanitizePayload(start, finalPayload);
  const diffs = diff(sanitizedSample, sanitizedFinal);
  return { chain, diffs, sampleFile: sample.file || 'fixture' };
}

async function convertInbound(payload, protocol) {
  const plan = createProtocolPlans(protocol).inbound;
  const context = {
    requestId: `chain-${protocol}-in-${Date.now()}`,
    entryEndpoint: protocol,
    providerProtocol: protocol
  };
  return runInboundPipeline({ rawRequest: payload, context, plan });
}

async function convertOutbound(chat, protocol) {
  const plan = createProtocolPlans(protocol).outbound;
  const context = {
    requestId: `chain-${protocol}-out-${Date.now()}`,
    entryEndpoint: protocol,
    providerProtocol: protocol
  };
  return runOutboundPipeline({ chat, context, plan });
}

function diff(a, b, prefix = '<root>') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a !== typeof b) return [{ path: prefix, expected: a, actual: b }];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) out.push(...diff(a[i], b[i], `${prefix}[${i}]`));
    return out;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out = [];
    for (const key of keys) out.push(...diff(a[key], b[key], `${prefix}.${key}`));
    return out;
  }
  return [{ path: prefix, expected: a, actual: b }];
}

async function main() {
  for (const chain of CHAINS) {
    const result = await runChain(chain);
    if (result.diffs.length) {
      console.error(`❌ Chain ${chain.join(' → ')} diff (${result.sampleFile}):`);
      result.diffs.slice(0, 10).forEach((entry) => {
        console.error(`  • ${entry.path}: expected =`, entry.expected, 'actual =', entry.actual);
      });
      if (result.diffs.length > 10) {
        console.error(`  ... total ${result.diffs.length} diffs`);
      }
      process.exit(1);
    } else {
      console.log(`✅ Chain ${chain.join(' → ')} matches (${result.sampleFile})`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
