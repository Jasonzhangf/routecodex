#!/usr/bin/env node

/**
 * Ensures anthropic request inbound/outbound conversions are mirror images.
 * Usage:
 *   node scripts/tests/anthropic-roundtrip.mjs --sample path/to/request.json [--sample ...]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const CODEC_PATH = path.join(
  repoRoot,
  'sharedmodule/llmswitch-core/dist/conversion/pipeline/codecs/v2/anthropic-openai-pipeline.js'
);
const DEFAULT_ENDPOINT = '/v1/messages';
const TMP_DIR = path.join(repoRoot, 'tmp');
const CODEC_HELPER_PATH = path.join(
  repoRoot,
  'sharedmodule/llmswitch-core/dist/conversion/codecs/anthropic-openai-codec.js'
);
const MESSAGE_UTILS_PATH = path.join(
  repoRoot,
  'sharedmodule/llmswitch-core/dist/conversion/shared/anthropic-message-utils.js'
);
const OPENAI_HELPER_PATH = path.join(
  repoRoot,
  'sharedmodule/llmswitch-core/dist/conversion/pipeline/codecs/v2/shared/openai-chat-helpers.js'
);

function parseArgs(argv) {
  const samples = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--sample' || arg === '-s') && i + 1 < argv.length) {
      samples.push(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!samples.length) {
    printUsage();
    process.exit(1);
  }
  return samples;
}

function printUsage() {
  console.log('Usage: node scripts/tests/anthropic-roundtrip.mjs --sample <request.json> [--sample ...]');
}

async function loadSamples(paths) {
  const entries = [];
  for (const target of paths) {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const files = await fs.readdir(target);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.json')) {
          entries.push(path.join(target, file));
        }
      }
    } else {
      entries.push(target);
    }
  }
  return entries;
}

async function loadCodec() {
  const mod = await import(pathToFileURL(CODEC_PATH));
  const Ctor = mod?.AnthropicOpenAIPipelineCodec;
  if (!Ctor) {
    throw new Error(`AnthropicOpenAIPipelineCodec missing in ${CODEC_PATH}`);
  }
  const codec = new Ctor();
  if (typeof codec.initialize === 'function') {
    await codec.initialize();
  }
  if (!codec.pipeline) {
    throw new Error('Codec pipeline not available.');
  }
  const helpers = await import(pathToFileURL(CODEC_HELPER_PATH));
  const messageUtils = await import(pathToFileURL(MESSAGE_UTILS_PATH));
  const openaiHelpers = await import(pathToFileURL(OPENAI_HELPER_PATH));
  return {
    pipeline: codec.pipeline,
    buildAnthropicRequestFromOpenAIChat: messageUtils.buildAnthropicRequestFromOpenAIChat,
    convertCanonicalToOpenAIChat: openaiHelpers.convertStandardizedToOpenAIChat
  };
}

function normalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeJson(value[key]);
      if (normalized !== undefined) {
        sorted[key] = normalized;
      }
    }
    return sorted;
  }
  return value;
}

async function runRoundtrip(runtime, filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const payload = JSON.parse(raw);
  const context = {
    entryEndpoint: DEFAULT_ENDPOINT,
    providerProtocol: 'anthropic-messages',
    targetProtocol: 'openai-chat',
    requestId: `roundtrip_${path.basename(filePath).replace(/[^a-zA-Z0-9_-]/g, '')}`,
    metadata: {}
  };
  const inbound = await runtime.pipeline.convertInbound({
    payload,
    context
  });
  const openaiPayload = await runtime.convertCanonicalToOpenAIChat(inbound.canonical, inbound.context);
  const chatPayload = { ...openaiPayload };
  const needsEmptyTools = Boolean(chatPayload.toolsFieldPresent && (!Array.isArray(chatPayload.tools) || chatPayload.tools.length === 0));
  if (needsEmptyTools) {
    chatPayload.tools = [];
  }
  const rebuilt = runtime.buildAnthropicRequestFromOpenAIChat(chatPayload);
  if (needsEmptyTools && (!Array.isArray(rebuilt.tools) || rebuilt.tools.length === 0)) {
    rebuilt.tools = [];
  }
  const expected = normalizeJson(payload);
  const actual = normalizeJson(rebuilt);
  const equal = JSON.stringify(expected) === JSON.stringify(actual);
  if (!equal) {
    await fs.mkdir(TMP_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(
      path.join(TMP_DIR, `${context.requestId}_expected.json`),
      JSON.stringify(expected, null, 2)
    ).catch(() => {});
    await fs.writeFile(
      path.join(TMP_DIR, `${context.requestId}_actual.json`),
      JSON.stringify(actual, null, 2)
    ).catch(() => {});
  }
  return equal;
}

async function main() {
  const sampleArgs = parseArgs(process.argv.slice(2));
  const sampleFiles = await loadSamples(sampleArgs);
  if (!sampleFiles.length) {
    console.error('No sample files found.');
    process.exit(1);
  }
  const runtime = await loadCodec();
  let failures = 0;
  for (const file of sampleFiles) {
    try {
      const ok = await runRoundtrip(runtime, file);
      if (ok) {
        console.log(`✅ roundtrip ok: ${file}`);
      } else {
        failures += 1;
        console.warn(`❌ roundtrip mismatch: ${file}`);
      }
    } catch (error) {
      failures += 1;
      console.error(`💥 failed on ${file}:`, error?.message ?? error);
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Unexpected error', error);
  process.exit(1);
});
