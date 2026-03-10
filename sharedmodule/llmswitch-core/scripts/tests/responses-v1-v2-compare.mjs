#!/usr/bin/env node
/**
 * Compare Responses legacy codec vs. v2 pipeline codec using codex samples.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist');
const samplesDir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');

const { ResponsesOpenAIConversionCodec: LegacyCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/codecs/responses-openai-codec.js')).href
);
const { ResponsesOpenAIPipelineCodec: PipelineCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/pipeline/codecs/v2/responses-openai-pipeline.js')).href
);

const legacyCodec = new LegacyCodec({});
const pipelineCodec = new PipelineCodec();
await legacyCodec.initialize();
await pipelineCodec.initialize();

const requestProfile = {
  id: 'responses-compare-request',
  codec: 'responses-openai',
  incomingProtocol: 'openai-responses',
  outgoingProtocol: 'openai-chat'
};

const responseProfile = {
  id: 'responses-compare-response',
  codec: 'responses-openai',
  incomingProtocol: 'openai-chat',
  outgoingProtocol: 'openai-responses'
};

const REQUEST_FIELDS = new Set([
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
  'presence_penalty',
  'parallel_tool_calls',
  'response_format',
  'user',
  'metadata',
  'logit_bias',
  'seed'
]);

const PIPELINE_REQUEST_DIAGNOSTICS = new Set([
  'standardizedRequest',
  'originalFormat',
  'targetFormat',
  'processedRequest',
  'processingSummary',
  'processingMetadata',
  'processed',
  'debug',
  'routingDecision',
  'routingDiagnostics',
  'standardizedResponse',
  'canonicalRequest',
  'normalizedRequest'
]);

const METADATA_DIAGNOSTICS = new Set([
  'capturedContext',
  'requestId',
  'stream',
  'originalStream',
  'governedTools',
  'governanceTimestamp',
  'providerKey',
  'providerType',
  'processMode',
  'routingDiagnostics'
]);

const RESPONSE_DIAGNOSTICS = new Set([
  'canonical',
  'standardizedResponse',
  'routingDiagnostics',
  'debug',
  'processedResponse',
  'responseSummary'
]);

function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const clean = {};
  for (const [key, val] of Object.entries(meta)) {
    if (METADATA_DIAGNOSTICS.has(key)) continue;
    clean[key] = val;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function stripRequestDiagnostics(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PIPELINE_REQUEST_DIAGNOSTICS.has(key)) continue;
    if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
      const sanitizedMetadata = sanitizeMetadata(value);
      if (sanitizedMetadata) clean.metadata = sanitizedMetadata;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function normalizeRequestPayload(payload) {
  const source = stripRequestDiagnostics(payload);
  const normalized = {};
  for (const key of Object.keys(source)) {
    if (!REQUEST_FIELDS.has(key)) continue;
    normalized[key] = source[key];
  }
  if (!Array.isArray(normalized.tools)) {
    normalized.tools = Array.isArray(source.tools) ? source.tools : [];
  }
  return normalized;
}

function compareObjects(a, b, projector) {
  const lhs = projector ? projector(a) : a;
  const rhs = projector ? projector(b) : b;
  return diffPayloads(lhs, rhs).length === 0;
}

function stripResponseDiagnostics(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESPONSE_DIAGNOSTICS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function normalizeResponsePayload(payload) {
  const clone = stripResponseDiagnostics(payload);
  if (typeof clone.id === 'string') clone.id = '__response_id__';
  if (clone.output && Array.isArray(clone.output)) {
    clone.output.forEach((item) => {
      if (item && typeof item === 'object') {
        if (typeof item.id === 'string') item.id = '__output_id__';
        if (typeof item.call_id === 'string') item.call_id = '__call_id__';
      }
    });
  }
  const calls = clone?.required_action?.submit_tool_outputs?.tool_calls;
  if (Array.isArray(calls)) {
    calls.forEach((call) => {
      if (call && typeof call === 'object' && typeof call.id === 'string') {
        call.id = '__tool_call_id__';
      }
    });
  }
  return clone;
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

async function main() {
  const entries = await fs.readdir(samplesDir);
  let requestCount = 0;
  let responseCount = 0;
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    let json;
    try {
      json = JSON.parse(await fs.readFile(path.join(samplesDir, file), 'utf-8'));
    } catch {
      continue;
    }
    const payload = json?.body?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const direction = json?.body?.direction;
    const stage = json?.meta?.stage || '';
    if (direction === 'request' && stage === 'format_parse') {
      requestCount += 1;
      const context = {
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        requestId: `req-${file}`,
        metadata: {}
      };
      const [legacy, pipeline] = await Promise.all([
        legacyCodec.convertRequest(payload, requestProfile, context),
        pipelineCodec.convertRequest(payload, requestProfile, context)
      ]);
      if (!compareObjects(legacy, pipeline, normalizeRequestPayload)) {
        throw new Error(`Responses request parity failed: ${file}`);
      }
      if (pipelineCodec.requestMetaStore?.clear) {
        pipelineCodec.requestMetaStore.clear();
      }
      if (legacyCodec.ctxMap?.clear) {
        legacyCodec.ctxMap.clear();
      }
    } else if (direction === 'response' && stage === 'resp_format_parse') {
      responseCount += 1;
      const context = {
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        requestId: `resp-${file}`,
        metadata: {}
      };
      const [legacy, pipeline] = await Promise.all([
        legacyCodec.convertResponse(payload, responseProfile, context),
        pipelineCodec.convertResponse(payload, responseProfile, context)
      ]);
      if (!compareObjects(legacy, pipeline, normalizeResponsePayload)) {
        throw new Error(`Responses response parity failed: ${file}`);
      }
      if (pipelineCodec.requestMetaStore?.clear) {
        pipelineCodec.requestMetaStore.clear();
      }
      if (legacyCodec.ctxMap?.clear) {
        legacyCodec.ctxMap.clear();
      }
    }
  }
  if (!requestCount) throw new Error(`No request samples found under ${samplesDir}`);
  if (!responseCount) throw new Error(`No response samples found under ${samplesDir}`);
  console.log(`✅ Responses request parity: ${requestCount} samples`);
  console.log(`✅ Responses response parity: ${responseCount} samples`);
  console.log('🎯 Responses v2 pipeline matches legacy codec for all streamed samples');
}

main().catch((err) => {
  console.error('❌ responses-v1-v2-compare failed:', err);
  process.exitCode = 1;
});
