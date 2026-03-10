#!/usr/bin/env node
/**
 * Compare OpenAI legacy codec vs. v2 pipeline codec using codex samples.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist');
const samplesDir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');

const { OpenAIOpenAIConversionCodec: LegacyCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/codecs/openai-openai-codec.js')).href
);
const { OpenAIOpenAIPipelineCodec: PipelineCodec } = await import(
  url.pathToFileURL(path.join(distRoot, 'conversion/pipeline/codecs/v2/openai-openai-pipeline.js')).href
);

const legacyCodec = new LegacyCodec({});
const pipelineCodec = new PipelineCodec();
await legacyCodec.initialize();
await pipelineCodec.initialize();

const baseProfile = {
  id: 'openai-compare',
  codec: 'openai-openai',
  incomingProtocol: 'openai-chat',
  outgoingProtocol: 'openai-chat'
};

const REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stop',
  'stream',
  'logit_bias',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'metadata',
  'parallel_tool_calls',
  'response_format',
  'user',
  'seed',
  'n'
]);

const RESPONSE_FIELDS = new Set([
  'id',
  'object',
  'created',
  'model',
  'choices',
  'usage',
  'system_fingerprint'
]);

function stripDiagnostics(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
      // remove debug metadata fields that are codec-specific
      const metaClean = {};
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (metaKey.startsWith('debug') || metaKey.startsWith('__')) continue;
        metaClean[metaKey] = metaValue;
      }
      if (Object.keys(metaClean).length) clean.metadata = metaClean;
      continue;
    }
    if (key.startsWith('standardized') || key.startsWith('canonical') || key === 'debug') {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function normalizeRequestPayload(payload) {
  const source = stripDiagnostics(payload);
  const normalized = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!REQUEST_FIELDS.has(key)) continue;
    normalized[key] = value;
  }
  if (!Array.isArray(normalized.messages) && Array.isArray(source?.messages)) {
    normalized.messages = source.messages;
  }
  if (!Array.isArray(normalized.tools) && Array.isArray(source?.tools)) {
    normalized.tools = source.tools;
  }
  return normalized;
}

function normalizeResponsePayload(payload) {
  const source = stripDiagnostics(payload);
  const normalized = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!RESPONSE_FIELDS.has(key)) continue;
    normalized[key] = value;
  }
  if (typeof normalized.id === 'string') normalized.id = '__response_id__';
  if (typeof normalized.created === 'number') normalized.created = 0;
  if (typeof normalized.system_fingerprint === 'string') normalized.system_fingerprint = '__fingerprint__';
  if (Array.isArray(normalized.choices)) {
    normalized.choices = normalized.choices.map((choice) => {
      if (!choice || typeof choice !== 'object') return choice;
      const clone = { ...choice };
      if (typeof clone.finish_reason === 'string') {
        clone.finish_reason = clone.finish_reason;
      }
      if (clone.message && typeof clone.message === 'object') {
        clone.message = { ...clone.message };
        if (typeof clone.message.id === 'string') clone.message.id = '__message_id__';
        if (Array.isArray(clone.message.tool_calls)) {
          clone.message.tool_calls = clone.message.tool_calls.map((toolCall) => {
            if (!toolCall || typeof toolCall !== 'object') return toolCall;
            const tc = { ...toolCall };
            if (typeof tc.id === 'string') tc.id = '__tool_call_id__';
            if (tc.function && typeof tc.function === 'object') {
              tc.function = { ...tc.function };
              if (tc.function.arguments && typeof tc.function.arguments === 'string') {
                tc.function.arguments = tc.function.arguments;
              }
            }
            return tc;
          });
        }
      }
      return clone;
    });
  }
  return normalized;
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
        entryEndpoint: json?.meta?.endpoint || '/v1/chat/completions',
        endpoint: json?.meta?.endpoint || '/v1/chat/completions',
        requestId: `req-${file}`,
        metadata: {}
      };
      const [legacy, pipeline] = await Promise.all([
        legacyCodec.convertRequest(payload, baseProfile, context),
        pipelineCodec.convertRequest(payload, baseProfile, context)
      ]);
      const diffs = diffPayloads(
        normalizeRequestPayload(legacy),
        normalizeRequestPayload(pipeline)
      );
      if (diffs.length) {
        console.error('Request diff sample:', file, diffs.slice(0, 3));
        throw new Error(`OpenAI request parity failed: ${file}`);
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
        entryEndpoint: json?.meta?.endpoint || '/v1/chat/completions',
        endpoint: json?.meta?.endpoint || '/v1/chat/completions',
        requestId: `resp-${file}`,
        metadata: {}
      };
      const [legacy, pipeline] = await Promise.all([
        legacyCodec.convertResponse(payload, baseProfile, context),
        pipelineCodec.convertResponse(payload, baseProfile, context)
      ]);
      const diffs = diffPayloads(
        normalizeResponsePayload(legacy),
        normalizeResponsePayload(pipeline)
      );
      if (diffs.length) {
        console.error('Response diff sample:', file, diffs.slice(0, 3));
        throw new Error(`OpenAI response parity failed: ${file}`);
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
  console.log(`✅ OpenAI request parity: ${requestCount} samples`);
  console.log(`✅ OpenAI response parity: ${responseCount} samples`);
  console.log('🎯 OpenAI v2 pipeline matches legacy codec for all codex samples');
}

main().catch((err) => {
  console.error('❌ openai-v1-v2-compare failed:', err);
  process.exitCode = 1;
});
