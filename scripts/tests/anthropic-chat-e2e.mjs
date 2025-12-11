#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const SAMPLES_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');
const RESPONSE_SUFFIX = '_provider-response.json';
const REQUEST_SUFFIX = '_provider-request.json';

function listProviderResponses() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(SAMPLES_DIR)
    .filter((file) => file.endsWith(RESPONSE_SUFFIX))
    .map((file) => path.join(SAMPLES_DIR, file));
}

function readJsonWithRepair(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    let idx = raw.lastIndexOf('}');
    while (idx > 0) {
      const candidate = raw.slice(0, idx + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        idx = raw.lastIndexOf('}', idx - 1);
      }
    }
    throw new Error(`无法解析 ${file}`);
  }
}

function extractToolUses(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const uses = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      uses.push({ id, name });
    }
  }
  return uses;
}

function shallowHash(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

async function loadCoreHelpers() {
  const distRoot = path.resolve('sharedmodule', 'llmswitch-core', 'dist');
  const runtimePath = path.join(distRoot, 'conversion', 'hub', 'response', 'response-runtime.js');
  const utilsPath = path.join(distRoot, 'conversion', 'shared', 'anthropic-message-utils.js');
  if (!fs.existsSync(runtimePath)) {
    throw new Error('sharedmodule/llmswitch-core/dist/conversion/hub/response/response-runtime.js 不存在，请先运行 npm run build:dev');
  }
  if (!fs.existsSync(utilsPath)) {
    throw new Error('sharedmodule/llmswitch-core/dist/conversion/shared/anthropic-message-utils.js 不存在');
  }
  const runtime = await import(pathToFileURL(runtimePath).href);
  const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof runtime.buildAnthropicResponseFromChat !== 'function' || typeof runtime.buildOpenAIChatFromAnthropicMessage !== 'function') {
    throw new Error('llmswitch-core 缺少 anthropic response 构造辅助函数');
  }
  if (typeof utils.buildAnthropicToolAliasMap !== 'function') {
    throw new Error('anthropic-message-utils 缺少 buildAnthropicToolAliasMap');
  }
  return {
    buildAnthropicResponseFromChat: runtime.buildAnthropicResponseFromChat,
    buildOpenAIChatFromAnthropicMessage: runtime.buildOpenAIChatFromAnthropicMessage,
    buildAnthropicToolAliasMap: utils.buildAnthropicToolAliasMap
  };
}

async function main() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.log('[anthropic-chat-e2e] 未找到 codex anthropic 样本，跳过');
    return;
  }

  const files = listProviderResponses();
  if (!files.length) {
    console.log('[anthropic-chat-e2e] 样本目录为空，跳过');
    return;
  }

  const {
    buildAnthropicResponseFromChat,
    buildOpenAIChatFromAnthropicMessage,
    buildAnthropicToolAliasMap
  } = await loadCoreHelpers();
  let checked = 0;
  let failures = 0;
  const failureDetails = [];

  for (const responseFile of files) {
    const responseDoc = readJsonWithRepair(responseFile);
    const providerPayload = pickProviderPayload(responseDoc);
    const providerTools = extractToolUses(providerPayload);
    if (!providerTools.length) {
      continue;
    }
    checked += 1;
    const requestFile = responseFile.replace(RESPONSE_SUFFIX, REQUEST_SUFFIX);
    const aliasFromRequest = loadAliasMap(requestFile, buildAnthropicToolAliasMap);
    const canonical = buildOpenAIChatFromAnthropicMessage(providerPayload);
    const mergedAliasMap = mergeAliasSources(aliasFromRequest, canonical?.anthropicToolNameMap);
    const rebuilt = buildAnthropicResponseFromChat(
      canonical,
      mergedAliasMap ? { aliasMap: mergedAliasMap } : undefined
    );
    const rebuiltTools = extractToolUses(rebuilt);
    if (providerTools.length !== rebuiltTools.length) {
      failures += 1;
      failureDetails.push({
        file: responseFile,
        reason: 'tool_use count mismatch',
        expected: providerTools.length,
        actual: rebuiltTools.length
      });
      continue;
    }
    const mismatch = providerTools.some((tool, idx) => shallowHash(tool) !== shallowHash(rebuiltTools[idx]));
    if (mismatch) {
      failures += 1;
      failureDetails.push({
        file: responseFile,
        reason: 'tool_use mismatch',
        expected: providerTools,
        actual: rebuiltTools
      });
    }
  }

  if (!checked) {
    console.log('[anthropic-chat-e2e] 没找到包含 tool_use 的样本，跳过');
    return;
  }

  if (failures) {
    console.error(`[anthropic-chat-e2e] 失败 ${failures}/${checked} 个样本，详见下方：`);
    for (const detail of failureDetails) {
      console.error('  -', detail.file, detail.reason, detail.expected ?? '', detail.actual ?? '');
    }
    process.exitCode = 1;
  } else {
    console.log(`[anthropic-chat-e2e] ✅ 所有 ${checked} 个 tool_use 样本一致`);
  }
}

function pickProviderPayload(doc) {
  if (!doc || typeof doc !== 'object') {
    return {};
  }
  if (doc.body && typeof doc.body === 'object') {
    if (doc.body.data && typeof doc.body.data === 'object') {
      return doc.body.data;
    }
    return doc.body;
  }
  return doc;
}

function loadAliasMap(requestFile, buildAnthropicToolAliasMap) {
  try {
    const requestDoc = readJsonWithRepair(requestFile);
    const tools =
      (requestDoc?.body && Array.isArray(requestDoc.body.tools) ? requestDoc.body.tools : null) ??
      (Array.isArray(requestDoc?.tools) ? requestDoc.tools : null);
    if (tools && tools.length) {
      return buildAnthropicToolAliasMap(tools);
    }
  } catch {
    // ignore alias map failures
  }
  return undefined;
}

function mergeAliasSources(primary, secondary) {
  const sources = [];
  if (primary && typeof primary === 'object') {
    sources.push(primary);
  }
  if (secondary && typeof secondary === 'object') {
    sources.push(secondary);
  }
  if (!sources.length) {
    return undefined;
  }
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        continue;
      }
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey.length || !trimmedValue.length) {
        continue;
      }
      if (!merged[trimmedKey]) {
        merged[trimmedKey] = trimmedValue;
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

main().catch((err) => {
  console.error('[anthropic-chat-e2e] 执行失败:', err);
  process.exitCode = 1;
});
