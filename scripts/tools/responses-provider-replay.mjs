#!/usr/bin/env node

/**
 * Responses provider replay harness.
 *
 * 加载 codex 样本 → 转换为 Chat → Responses 请求 → 直接调用 Responses Provider。
 * 支持替换系统提示词、dry-run 只看 preprocess、或真实发到上游。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CORE_DIST = path.join(ROOT, 'sharedmodule', 'llmswitch-core', 'dist');

const DEFAULT_CONFIG = path.join(os.homedir(), '.routecodex', 'provider', 'c4m', 'config.v1.json');
const DEFAULT_TARGET = 'c4m.gpt-5.1';

function usage(err) {
  if (err) console.error(`❌ ${err}`);
  console.log(`Usage:
  node scripts/tools/responses-provider-replay.mjs --sample <codex-sample.json>
      [--config ${DEFAULT_CONFIG}]
      [--target c4m.gpt-5.1]
      [--system-source <anthropic-sample.json>]
      [--entry-endpoint </v1/messages>]
      [--dry-run]
      [--dump ./tmp/replay.json]
`);
  process.exit(err ? 1 : 0);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    sample: null,
    config: DEFAULT_CONFIG,
    target: DEFAULT_TARGET,
    systemSource: null,
    entryEndpoint: null,
    dryRun: false,
    dumpPath: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sample') opts.sample = argv[++i];
    else if (arg === '--config') opts.config = argv[++i];
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--system-source') opts.systemSource = argv[++i];
    else if (arg === '--entry-endpoint') opts.entryEndpoint = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--dump') opts.dumpPath = argv[++i];
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`Unknown argument: ${arg}`);
  }
  if (!opts.sample) usage('Missing --sample');
  return opts;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function looksAnthropic(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.protocol === 'anthropic-messages') return true;
  if (Array.isArray(node.system)) return true;
  if (Array.isArray(node.messages) && node.messages.some((m) => Array.isArray(m?.content))) return true;
  if (typeof node.stop_reason === 'string' && typeof node.role === 'string') return true;
  return false;
}

function looksResponses(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.protocol === 'openai-responses') return true;
  if (Array.isArray(node.input)) return true;
  if (typeof node.instructions === 'string') return true;
  if (node.object === 'response' && Array.isArray(node.output)) return true;
  return false;
}

function looksChat(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.messages) && node.messages.every((m) => typeof m?.role === 'string')) return true;
  return false;
}

function directPayloadCandidate(doc) {
  const candidates = [
    doc?.body?.payload,
    doc?.body?.request,
    doc?.body?.data,
    doc?.payload,
    doc?.data?.payload,
    doc?.data?.body,
    doc?.request?.body,
    doc?.body
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return null;
}

function bfsFindPayload(doc) {
  const queue = [doc];
  const seen = new WeakSet();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (looksAnthropic(current)) return { payload: current, kind: 'anthropic' };
    if (looksResponses(current)) return { payload: current, kind: 'responses' };
    if (looksChat(current)) return { payload: current, kind: 'chat' };
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function resolveEntryEndpoint(doc, fallback = '/v1/messages') {
  return doc?.meta?.endpoint ||
    doc?.body?.endpoint ||
    doc?.data?.meta?.entryEndpoint ||
    doc?.body?.meta?.entryEndpoint ||
    fallback;
}

async function loadCoreModules() {
  const anthPath = path.join(CORE_DIST, 'conversion', 'codecs', 'anthropic-openai-codec.js');
  const respPath = path.join(CORE_DIST, 'conversion', 'responses', 'responses-openai-bridge.js');
  const anth = await import(pathToFileURL(anthPath).href);
  const resp = await import(pathToFileURL(respPath).href);
  const required = [
    'buildOpenAIChatFromAnthropic',
    'buildResponsesRequestFromChat',
    'buildChatRequestFromResponses',
    'captureResponsesContext'
  ];
  if (typeof anth.buildOpenAIChatFromAnthropic !== 'function') throw new Error('buildOpenAIChatFromAnthropic missing');
  if (typeof resp.buildResponsesRequestFromChat !== 'function' ||
      typeof resp.buildChatRequestFromResponses !== 'function' ||
      typeof resp.captureResponsesContext !== 'function') {
    throw new Error('Responses bridge helpers missing');
  }
  return {
    buildOpenAIChatFromAnthropic: anth.buildOpenAIChatFromAnthropic,
    buildResponsesRequestFromChat: resp.buildResponsesRequestFromChat,
    buildChatRequestFromResponses: resp.buildChatRequestFromResponses,
    captureResponsesContext: resp.captureResponsesContext
  };
}

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function extractSystemMessages(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  return messages.filter((m) => m && typeof m === 'object' && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.join('\n') : ''))
    .map((text) => text.trim())
    .filter(Boolean);
}

function replaceSystemMessages(chat, replacements) {
  const rest = (Array.isArray(chat?.messages) ? chat.messages : []).filter((m) => m.role !== 'system');
  const systemEntries = replacements.map((text) => ({ role: 'system', content: text }));
  return { ...chat, messages: [...systemEntries, ...rest] };
}

async function convertSampleToChat(samplePath, modules) {
  const doc = readJson(samplePath);
  let info = null;
  const direct = directPayloadCandidate(doc);
  if (direct && typeof direct === 'object') {
    if (looksAnthropic(direct)) info = { payload: direct, kind: 'anthropic' };
    else if (looksResponses(direct)) info = { payload: direct, kind: 'responses' };
    else if (looksChat(direct)) info = { payload: direct, kind: 'chat' };
  }
  if (!info) {
    info = bfsFindPayload(doc);
  }
  if (!info) throw new Error(`无法在样本中找到可识别 payload: ${samplePath}`);
  const entryEndpoint = resolveEntryEndpoint(doc, info.kind === 'responses' ? '/v1/responses' : '/v1/messages');
  if (info.kind === 'anthropic') {
    const chat = modules.buildOpenAIChatFromAnthropic(info.payload);
    return { chat, entryEndpoint, payloadKind: 'anthropic' };
  }
  if (info.kind === 'responses') {
    const ctx = modules.captureResponsesContext(info.payload, { route: { requestId: `replay-${Date.now()}` } });
    const { request } = modules.buildChatRequestFromResponses(info.payload, ctx);
    return { chat: request, entryEndpoint, payloadKind: 'responses' };
  }
  return { chat: deepClone(info.payload), entryEndpoint, payloadKind: 'chat' };
}

async function initProvider(configPath, target) {
  const config = readJson(configPath);
  const [providerId, modelId = 'gpt-5.1'] = target.split('.');
  const providerDef = config?.virtualrouter?.providers?.[providerId];
  if (!providerDef) throw new Error(`Provider ${providerId} not found in ${configPath}`);
  const auth = providerDef.auth || {};
  const apiKey = auth.apiKey || auth.value || process.env.C4M_API_KEY;
  if (!apiKey) throw new Error(`Missing API key for ${providerId}. set in config or C4M_API_KEY env`);
  const runtime = {
    runtimeKey: `${providerId}.replay.${Date.now()}`,
    providerId,
    providerKey: `${providerId}.replay`,
    keyAlias: 'replay',
    providerType: (providerDef.type || 'responses').toLowerCase(),
    endpoint: providerDef.baseURL || providerDef.baseUrl || providerDef.endpoint || 'https://api.example.net/v1',
    auth: { type: 'apikey', value: apiKey },
    compatibilityProfile: providerDef.compat || 'default',
    outboundProfile: 'openai-responses',
    defaultModel: modelId
  };
  const { ProviderFactory } = await import(pathToFileURL(
    path.join(ROOT, 'dist/modules/pipeline/modules/provider/v2/core/provider-factory.js')
  ).href);
  const provider = ProviderFactory.createProviderFromRuntime(runtime, {
    logger: {
      logModule: (module, event, data) => {
        if (process.env.REPLAY_LOG_VERBOSE === '1') console.log(`[${module}] ${event}`, data || '');
      },
      logError: (error, ctx) => console.error('[replay] logError', error.message, ctx || {}),
      logProviderRequest: () => {},
      logProviderResponse: () => {}
    },
    errorHandlingCenter: { handleError: () => {} },
    debugCenter: { log: () => {} }
  });
  await provider.initialize();
  const runtimeHelpers = await import(pathToFileURL(
    path.join(ROOT, 'dist/modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.js')
  ).href);
  return { provider, runtime, runtimeHelpers };
}

async function main() {
  const options = parseArgs();
  const modules = await loadCoreModules();
  const { provider, runtime, runtimeHelpers } = await initProvider(options.config, options.target);
  try {
    const subject = await convertSampleToChat(options.sample, modules);
    let replayChat = deepClone(subject.chat);
    console.log(`[replay] loaded sample ${options.sample}`);
    console.log(` - entryEndpoint: ${options.entryEndpoint || subject.entryEndpoint}`);
    console.log(` - payload kind: ${subject.payloadKind}`);
    console.log(` - existing system prompts: ${extractSystemMessages(replayChat).length}`);

    if (options.systemSource) {
      const replacement = await convertSampleToChat(options.systemSource, modules);
      const replacementSystems = extractSystemMessages(replacement.chat);
      if (!replacementSystems.length) throw new Error(`System source ${options.systemSource} 未找到系统提示`);
      replayChat = replaceSystemMessages(replayChat, replacementSystems);
      console.log(` - replaced system prompts using ${options.systemSource} (${replacementSystems.length} blocks)`);
    }

    if (!replayChat.model) replayChat.model = runtime.defaultModel;

    const { request: responsesRequest } = await modules.buildResponsesRequestFromChat(deepClone(replayChat));
    if (!responsesRequest || typeof responsesRequest !== 'object') throw new Error('buildResponsesRequestFromChat failed');
    if (!responsesRequest.model) responsesRequest.model = runtime.defaultModel;

    if (options.dumpPath) {
      fs.writeFileSync(options.dumpPath, JSON.stringify({ chat: replayChat, responses: responsesRequest }, null, 2));
      console.log(` - dumped payloads → ${options.dumpPath}`);
    }

    const providerRequest = {
      data: responsesRequest,
      metadata: {
        entryEndpoint: options.entryEndpoint || subject.entryEndpoint || '/v1/messages',
        stream: responsesRequest.stream === true
      }
    };

    const requestId = `replay-${Date.now()}`;
    runtimeHelpers.attachProviderRuntimeMetadata(providerRequest, {
      requestId,
      providerId: runtime.providerId,
      providerKey: runtime.providerKey,
      providerType: runtime.providerType,
      providerProtocol: 'openai-responses',
      routeName: 'replay',
      target: {
        providerKey: `${runtime.providerId}.${runtime.keyAlias}.${runtime.defaultModel}`,
        providerType: runtime.providerType,
        compatibilityProfile: runtime.compatibilityProfile,
        runtimeKey: runtime.runtimeKey,
        modelId: runtime.defaultModel
      },
      metadata: {
        stream: responsesRequest.stream === true,
        entryEndpoint: providerRequest.metadata.entryEndpoint
      }
    });

    if (options.dryRun) {
      console.log('[replay] dry-run preprocess only');
      const sanitized = await provider.preprocessRequest(providerRequest);
      console.log(JSON.stringify(sanitized?.data || sanitized, null, 2));
      return;
    }

    console.log('[replay] sending request to provider…');
    const response = await provider.processIncoming(providerRequest);
    console.log('✅ provider responded');
    const status = response?.status ?? response?.data?.status ?? 'unknown';
    console.log(` - status: ${status}`);
    const dumpFile = path.join(process.cwd(), `replay_${requestId}_response.json`);
    fs.writeFileSync(dumpFile, JSON.stringify(response, null, 2));
    console.log(` - saved response to ${dumpFile}`);
  } finally {
    await provider.cleanup().catch(() => {});
  }
}

main().catch((error) => {
  console.error('[responses-provider-replay] failed:', error);
  process.exit(1);
});
