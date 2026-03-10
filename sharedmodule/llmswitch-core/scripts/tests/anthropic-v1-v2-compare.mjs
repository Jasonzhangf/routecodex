#!/usr/bin/env node
/**
 * Compare Anthropic legacy codec vs. v2 pipeline codec using codex samples.
 * Ensures request/response conversions remain identical (black-box parity).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist');
const samplesDir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');

const { AnthropicOpenAIConversionCodec: LegacyCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/codecs/anthropic-openai-codec.js')).href
);
const { AnthropicOpenAIPipelineCodec: PipelineCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/pipeline/codecs/v2/anthropic-openai-pipeline.js')).href
);

const legacyCodec = new LegacyCodec({});
const pipelineCodec = new PipelineCodec();
await legacyCodec.initialize();
await pipelineCodec.initialize();

const testProfile = {
  id: 'anthropic-compare',
  codec: 'anthropic-openai',
  incomingProtocol: 'anthropic-messages',
  outgoingProtocol: 'openai-chat'
};

const baseContext = {
  entryEndpoint: '/v1/messages',
  endpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages',
  targetProtocol: 'openai-chat',
  metadata: {}
};

const REQUEST_FIELD_WHITELIST = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'tool_choice_mode',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'stop_sequences',
  'frequency_penalty',
  'presence_penalty'
]);

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = stable(value[key]);
    }
    return output;
  }
  return value;
}

function snapshot(obj, projector) {
  const projected = projector ? projector(obj) : obj;
  return JSON.stringify(stable(projected));
}

function normalizeRequestPayload(payload) {
  const normalized = {};
  for (const key of Object.keys(payload)) {
    if (!REQUEST_FIELD_WHITELIST.has(key)) continue;
    normalized[key] = payload[key];
  }
  if (!Array.isArray(normalized.tools)) {
    normalized.tools = Array.isArray(payload.tools) ? payload.tools : [];
  }
  return normalized;
}

async function collectSamples() {
  const entries = await fs.readdir(samplesDir);
  const requests = [];
  const responses = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const json = JSON.parse(await fs.readFile(path.join(samplesDir, file), 'utf-8'));
    const payload = json?.body?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const direction = json?.body?.direction;
    const stage = json?.meta?.stage || '';
    if (direction === 'request' && stage === 'format_parse') {
      requests.push({ file, payload });
    } else if (direction === 'response' && stage === 'resp_format_parse') {
      responses.push({ file, payload });
    }
  }
  if (!requests.length) {
    throw new Error(`No Anthropic request samples found in ${samplesDir}`);
  }
  if (!responses.length) {
    throw new Error(`No Anthropic response samples found in ${samplesDir}`);
  }
  return { requests, responses };
}

async function compareRequests(requests) {
  const mismatches = [];
  for (const sample of requests) {
    const context = { ...baseContext, requestId: `req-${sample.file}` };
    const [legacy, pipeline] = await Promise.all([
      legacyCodec.convertRequest(sample.payload, testProfile, context),
      pipelineCodec.convertRequest(sample.payload, testProfile, context)
    ]);
    if (snapshot(legacy, normalizeRequestPayload) !== snapshot(pipeline, normalizeRequestPayload)) {
      mismatches.push({ file: sample.file, type: 'request', legacy, pipeline });
    }
  }
  if (mismatches.length) {
    const details = mismatches
      .map((m) => `• ${m.type} ${m.file}`)
      .join('\n');
    throw new Error(`Request parity failed:\n${details}`);
  }
  console.log(`✅ Anthropic request parity: ${requests.length} samples`);
}

async function compareResponses(responses) {
  const mismatches = [];
  for (const sample of responses) {
    const context = {
      ...baseContext,
      requestId: `resp-${sample.file}`,
      targetProtocol: 'anthropic-messages',
      providerProtocol: 'openai-chat'
    };
    const profile = {
      ...testProfile,
      incomingProtocol: 'openai-chat',
      outgoingProtocol: 'anthropic-messages'
    };
    const [legacy, pipeline] = await Promise.all([
      legacyCodec.convertResponse(sample.payload, profile, context),
      pipelineCodec.convertResponse(sample.payload, profile, context)
    ]);
    if (snapshot(legacy) !== snapshot(pipeline)) {
      mismatches.push({ file: sample.file, type: 'response' });
    }
  }
  if (mismatches.length) {
    const details = mismatches
      .map((m) => `• ${m.type} ${m.file}`)
      .join('\n');
    throw new Error(`Response parity failed:\n${details}`);
  }
  console.log(`✅ Anthropic response parity: ${responses.length} samples`);
}

async function main() {
  const { requests, responses } = await collectSamples();
  await compareRequests(requests);
  await compareResponses(responses);
  console.log('🎯 Anthropic v2 pipeline matches legacy codec for all samples');
}

main().catch((err) => {
  console.error('❌ anthropic-v1-v2-compare failed:', err);
  process.exitCode = 1;
});
