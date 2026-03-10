#!/usr/bin/env node
/**
 * Codex samples provider-response regression (shape + tool_call invariants).
 *
 * 目标：
 *  - 使用 codex-samples 下的 *_provider-response.json 样本，
 *    走一次 provider-response → Chat → client 协议的完整链路；
 *  - 对 openai-responses 终态 payload 做 tool_call_id 配对/形态校验；
 *  - 为后续按需扩展更多入口 / 协议留出挂载点。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { convertProviderResponse } from '../../dist/conversion/index.js';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const defaultSamplesDir = path.join(projectRoot, 'tests', 'fixtures', 'codex-samples');
const samplesBase = process.env.CODEX_SAMPLES_DIR || defaultSamplesDir;

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[matrix:codex] ${message}`);
}

async function listProviderResponseFiles(entry) {
  const dir = path.join(samplesBase, entry);
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((name) => name.endsWith('_provider-response.json') || name === 'sample_provider-response.json')
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function loadJson(file) {
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw);
}

function extractProviderPayload(doc) {
  if (!doc || typeof doc !== 'object') {
    return undefined;
  }
  if (doc.body && typeof doc.body === 'object') {
    return doc.body;
  }
  if (doc.data?.body && typeof doc.data.body === 'object') {
    return doc.data.body;
  }
  if (doc.data?.body?.data && typeof doc.data.body.data === 'object') {
    return doc.data.body.data;
  }
  if (doc.data && typeof doc.data === 'object') {
    return doc.data;
  }
  return undefined;
}

function resolveProviderProtocol(entry) {
  if (entry === 'openai-chat') return 'openai-chat';
  if (entry === 'openai-responses') return 'openai-responses';
  if (entry === 'anthropic-messages') return 'anthropic-messages';
  return 'openai-chat';
}

function resolveEntryEndpoint(entry, doc) {
  const metaEndpoint =
    doc &&
    typeof doc === 'object' &&
    doc.meta &&
    typeof doc.meta.entryEndpoint === 'string' &&
    doc.meta.entryEndpoint.trim();
  if (metaEndpoint) {
    return doc.meta.entryEndpoint.trim();
  }
  if (entry === 'openai-chat') return '/v1/chat/completions';
  if (entry === 'openai-responses') return '/v1/responses';
  if (entry === 'anthropic-messages') return '/v1/messages';
  return '/v1/chat/completions';
}

function buildAdapterContext(entry, doc, payload, label) {
  const meta = (doc && typeof doc === 'object' && doc.meta && typeof doc.meta === 'object') ? doc.meta : {};
  const bodyMeta =
    payload && typeof payload === 'object' && payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};

  const model = typeof payload?.model === 'string' ? payload.model.trim() : undefined;
  const requestId =
    (typeof meta.clientRequestId === 'string' && meta.clientRequestId.trim()) ||
    (typeof bodyMeta.requestId === 'string' && bodyMeta.requestId.trim()) ||
    `codex_${entry}_${label}`;

  return {
    requestId,
    entryEndpoint: resolveEntryEndpoint(entry, doc),
    providerProtocol: resolveProviderProtocol(entry),
    providerId: typeof meta.providerKey === 'string' ? meta.providerKey : undefined,
    routeId: typeof meta.routeId === 'string' ? meta.routeId : undefined,
    profileId: typeof meta.profileId === 'string' ? meta.profileId : undefined,
    streamingHint: 'auto',
    originalModelId: model,
    clientModelId: model,
    toolCallIdStyle: 'fc'
  };
}

function createStageRecorder() {
  const stages = new Map();
  return {
    recorder: {
      record(stage, payload) {
        stages.set(stage, payload);
      }
    },
    stages
  };
}

function collectResponsesNameViolations(payload) {
  const failures = [];
  const check = (value, location) => {
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
    if (!NAME_REGEX.test(value)) {
      failures.push({ location, value });
    }
  };

  if (!payload || typeof payload !== 'object') {
    return failures;
  }

  const record = payload;

  // tools[].function.name
  if (Array.isArray(record.tools)) {
    record.tools.forEach((tool, index) => {
      if (!tool || typeof tool !== 'object') return;
      if (tool.function && typeof tool.function === 'object') {
        check(tool.function.name, `tools[${index}].function.name`);
      }
    });
  }

  // output[*].tool_calls[].function.name
  if (Array.isArray(record.output)) {
    record.output.forEach((entry, oi) => {
      const toolCalls = entry && typeof entry === 'object' && Array.isArray(entry.tool_calls)
        ? entry.tool_calls
        : [];
      toolCalls.forEach((tc, ti) => {
        if (!tc || typeof tc !== 'object') return;
        if (tc.function && typeof tc.function === 'object') {
          check(tc.function.name, `output[${oi}].tool_calls[${ti}].function.name`);
        }
      });
    });
  }

  // required_action.submit_tool_outputs.tool_calls[].name
  const ra = record.required_action && typeof record.required_action === 'object'
    ? record.required_action
    : undefined;
  const submit = ra && typeof ra === 'object' ? ra.submit_tool_outputs : undefined;
  const submitCalls = submit && typeof submit === 'object' ? submit.tool_calls : undefined;
  if (Array.isArray(submitCalls)) {
    submitCalls.forEach((tc, i) => {
      if (!tc || typeof tc !== 'object') return;
      check(tc.name, `required_action.submit_tool_outputs.tool_calls[${i}].name`);
    });
  }

  return failures;
}

function collectResponsesToolCallIdInvariants(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return errors;
  }

  const isToolCallIdOk = (raw) => /^((fc|call)_[A-Za-z0-9_-]+)$/i.test(String(raw || '').trim());
  const allIds = new Set();

  // 收集并校验 output[*].tool_calls[*].id
  if (Array.isArray(payload.output)) {
    payload.output.forEach((entry, oi) => {
      if (!entry || typeof entry !== 'object') return;
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      toolCalls.forEach((tc, ti) => {
        if (!tc || typeof tc !== 'object') return;
        const rawId = typeof tc.id === 'string' ? tc.id.trim() : '';
        if (!rawId) {
          errors.push(`output[${oi}].tool_calls[${ti}].id missing`);
          return;
        }
        allIds.add(rawId);
        // Accept both OpenAI-style `call_*` and normalized `fc_*` ids.
        if (!isToolCallIdOk(rawId)) {
          errors.push(`output[${oi}].tool_calls[${ti}].id has invalid format: ${rawId}`);
        }
      });
    });
  }

  // required_action.submit_tool_outputs.tool_calls[*].tool_call_id 必须存在且可在 output.tool_calls 中找到。
  const requiredAction = payload.required_action && typeof payload.required_action === 'object'
    ? payload.required_action
    : undefined;
  const submit = requiredAction && typeof requiredAction === 'object'
    ? requiredAction.submit_tool_outputs
    : undefined;
  const submitCalls = submit && typeof submit === 'object'
    ? submit.tool_calls
    : undefined;

  if (Array.isArray(submitCalls)) {
    submitCalls.forEach((tc, i) => {
      if (!tc || typeof tc !== 'object') return;
      const rawId = typeof tc.tool_call_id === 'string' ? tc.tool_call_id.trim() : '';
      if (!rawId) {
        errors.push(`required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id missing`);
        return;
      }
      if (!isToolCallIdOk(rawId)) {
        errors.push(
          `required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id has invalid format: ${rawId}`
        );
      }
      if (allIds.size > 0 && !allIds.has(rawId)) {
        errors.push(
          `required_action.submit_tool_outputs.tool_calls[${i}].tool_call_id=${rawId} has no matching output.tool_calls entry`
        );
      }
    });
  }

  return errors;
}

async function runEntry(entry) {
  const files = await listProviderResponseFiles(entry);
  if (!files.length) {
    log(`skip ${entry}: no provider-response samples found under ${samplesBase}`);
    return;
  }

  for (const file of files) {
    const basename = path.basename(file);
    const doc = await loadJson(file);
    const payload = extractProviderPayload(doc);
    assert.ok(payload && typeof payload === 'object', `Sample ${basename} missing provider payload`);

    const adapterContext = buildAdapterContext(entry, doc, payload, basename);
    const { recorder, stages } = createStageRecorder();

    const result = await convertProviderResponse({
      providerProtocol: resolveProviderProtocol(entry),
      providerResponse: payload,
      context: adapterContext,
      entryEndpoint: adapterContext.entryEndpoint,
      wantsStream: false,
      stageRecorder: recorder
    });

    assert.ok(result, `convertProviderResponse(${basename}) returned empty result`);

    if (result.__sse_responses) {
      // 当前 codex-samples fixture 均为 JSON 终态；如未来新增 SSE，必要时在此扩展 SSE 聚合测试。
      log(`sample ${basename} produced SSE stream; skipping JSON invariants for now.`);
      continue;
    }

    const body = result.body;
    assert.ok(body && typeof body === 'object', `Sample ${basename} produced no JSON body`);

    if (result.format === 'openai-responses') {
      const nameViolations = collectResponsesNameViolations(body);
      if (nameViolations.length) {
        const msgLines = nameViolations.map((v) => ` - ${v.location}: ${v.value}`);
        throw new Error(
          `responses payload from ${basename} still contains invalid tool names:\n${msgLines.join('\n')}`
        );
      }
      const idErrors = collectResponsesToolCallIdInvariants(body);
      if (idErrors.length) {
        const msgLines = idErrors.map((v) => ` - ${v}`);
        throw new Error(
          `responses payload from ${basename} tool_call_id invariants failed:\n${msgLines.join('\n')}`
        );
      }
    }

    // 预留：如需对 resp_inbound_stage3_semantic_map.chat 形状做进一步断言，
    // 可从 stages.get('resp_inbound_stage3_semantic_map.chat') 读取 ChatCompletionLike。
    void stages;
  }
}

async function main() {
  // 确保样本基目录存在；若不存在则默默跳过整个测试（交由其他矩阵脚本负责样本捕获）。
  try {
    await fs.access(samplesBase);
  } catch {
    log(`samples base not found (${samplesBase}), skipping codex-matrix regression.`);
    return;
  }

  await runEntry('openai-chat');
  await runEntry('openai-responses');
  await runEntry('anthropic-messages');

  log('codex-samples provider-response matrix passed');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('❌ codex-matrix regression failed:', error && error.message ? error.message : error);
  process.exit(1);
});
