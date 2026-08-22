#!/usr/bin/env node
/**
 * Offline analysis script:
 * - Walks ~/.routecodex/codex-samples/openai-responses
 * - For each resp_outbound_stage1_client_remap.json sample:
 *   - Reads upstream usage.input_tokens/prompt_tokens
 *   - Estimates input tokens from the matching client-request payload
 *     using a unified tiktoken-based counter.
 *   - Computes relative error and compares with the previous sample
 *     from a different provider.
 *
 * This does NOT change runtime behaviour; it only prints statistics
 * about how often our estimator would override upstream usage under
 * the "20% + previous-provider" heuristic.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encoding_for_model } from 'tiktoken';

const BASE_DIR =
  process.env.ROUTECODEX_CODEX_SAMPLES_DIR ||
  path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');

const RESP_SUFFIX = '_resp_outbound_stage1_client_remap.json';
const INBOUND_CHAT_SUFFIX = '_resp_inbound_stage3_semantic_map.chat.json';
const CLIENT_REQ_SUFFIX = '_client-request.json';

function listRespSamples() {
  const entries = fs.readdirSync(BASE_DIR);
  return entries
    .filter((name) => name.endsWith(RESP_SUFFIX))
    .sort(); // lexicographic sort ~ time order for our filenames
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deriveClientRequestName(respName) {
  // Example:
  //  resp: openai-responses-tabglm.key1.glm-4.7-...-20260110T182319509-047_resp_outbound_stage1_client_remap.json
  //  client: openai-responses-unknown-unknown-20260110T182319509-047_client-request.json
  //
  // 部分旧样本并没有保存对应的 client-request 快照，遇到这种情况直接跳过。
  const match = respName.match(/openai-responses-.*-(\d{8}T\d{9}-\d+)_resp_outbound_stage1_client_remap\.json$/);
  if (!match) return null;
  const tsPart = match[1];
  return `openai-responses-unknown-unknown-${tsPart}${CLIENT_REQ_SUFFIX}`;
}

function extractProviderKey(respName) {
  // openai-responses-<providerKey>-<model>-<timestamp>_resp_outbound...
  const withoutSuffix = respName.replace(RESP_SUFFIX, '');
  const parts = withoutSuffix.split('-');
  if (parts.length < 4) return 'unknown';
  // parts[0] = 'openai-responses'
  return parts[1] || 'unknown';
}

const encoder = encoding_for_model('gpt-4o');

function encodeText(text) {
  if (!text || !text.trim()) return 0;
  return encoder.encode(text).length;
}

function estimateInputTokensFromClientRequest(clientPayload) {
  // For /v1/responses, most recent samples store the original
  // OpenAI/Responses request under requestMetadata.__raw_request_body.
  // We use that as the canonical context snapshot for estimation.
  try {
    const body = clientPayload.body && typeof clientPayload.body === 'object'
      ? clientPayload.body
      : clientPayload;
    const raw =
      body?.requestMetadata?.__raw_request_body ??
      body?.__raw_request_body ??
      body;
    return encodeText(JSON.stringify(raw));
  } catch {
    // Fallback: encode entire payload JSON
    return encodeText(JSON.stringify(clientPayload));
  }
}

function loadRawUpstreamUsage(respName, remapJson) {
  // Read ONLY the inbound semantic-map.chat snapshot, which preserves
  // the provider's original usage as closely as possible.
  // 如果没有这份快照，就跳过该样本，不再回退到 remap usage。
  const prefix = respName.replace(RESP_SUFFIX, '');
  const inboundChatName = `${prefix}${INBOUND_CHAT_SUFFIX}`;
  const inboundChatPath = path.join(BASE_DIR, inboundChatName);
  if (fs.existsSync(inboundChatPath)) {
    try {
      const inbound = loadJson(inboundChatPath);
      const usage =
        (inbound && typeof inbound === 'object' && inbound.usage) ||
        (inbound && inbound.payload && inbound.payload.usage) ||
        undefined;
      if (usage && typeof usage === 'object') {
        return usage;
      }
    } catch {
      // malformed inbound snapshot, treat as missing
    }
  }

  // No raw upstream usage available for this sample.
  return undefined;
}

function extractUpstreamInputUsage(usageNode) {
  if (!usageNode || typeof usageNode !== 'object') return undefined;
  const u = usageNode;
  const prompt =
    typeof u.prompt_tokens === 'number'
      ? u.prompt_tokens
      : typeof u.input_tokens === 'number'
        ? u.input_tokens
        : undefined;
  return typeof prompt === 'number' && Number.isFinite(prompt) && prompt > 0 ? prompt : undefined;
}

function main() {
  if (!fs.existsSync(BASE_DIR) || !fs.statSync(BASE_DIR).isDirectory()) {
    console.error('[analyze-usage-estimate] codex-samples directory not found:', BASE_DIR);
    process.exit(1);
  }

  const respFiles = listRespSamples();
  if (!respFiles.length) {
    console.log('[analyze-usage-estimate] no resp_outbound_stage1_client_remap samples found');
    return;
  }

  const samples = [];

  for (const respName of respFiles) {
    const respPath = path.join(BASE_DIR, respName);
    let resp;
    try {
      resp = loadJson(respPath);
    } catch {
      // skip malformed
      continue;
    }
    const upstreamUsage = loadRawUpstreamUsage(respName, resp);
    const upstreamInput = extractUpstreamInputUsage(upstreamUsage);
    if (upstreamInput === undefined) {
      continue;
    }

    const clientReqName = deriveClientRequestName(respName);
    if (!clientReqName) {
      continue;
    }
    const clientReqPath = path.join(BASE_DIR, clientReqName);
    if (!fs.existsSync(clientReqPath)) {
      continue;
    }
    let clientReq;
    try {
      clientReq = loadJson(clientReqPath);
    } catch {
      // malformed client snapshot, skip
      continue;
    }
    const estimatedInput = estimateInputTokensFromClientRequest(clientReq);
    if (!Number.isFinite(estimatedInput) || estimatedInput <= 0) {
      continue;
    }

    const providerKey = extractProviderKey(respName);
    samples.push({
      file: respName,
      providerKey,
      upstreamInput,
      estimatedInput,
      relError: Math.abs(upstreamInput - estimatedInput) / Math.max(upstreamInput, 1)
    });
  }

  // Sort by filename (approximate time order)
  samples.sort((a, b) => a.file.localeCompare(b.file));

  const THRESHOLD = 0.4;
  let total = 0;
  let withPrev = 0;
  let overrideCount = 0;
  const perProvider = new Map();

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    total++;

    // Find previous sample from a different provider
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (samples[j].providerKey !== s.providerKey) {
        prev = samples[j];
        break;
      }
    }

    let decision = 'keep_upstream';
    if (prev) {
      withPrev++;
      const currErr = s.relError;
      const prevErr = prev.relError;
      if (currErr > THRESHOLD && prevErr <= THRESHOLD && prevErr < currErr) {
        decision = 'prefer_estimate';
        overrideCount++;
      }
    }

    const bucket = perProvider.get(s.providerKey) || { total: 0, overrides: 0 };
    bucket.total++;
    if (decision === 'prefer_estimate') bucket.overrides++;
    perProvider.set(s.providerKey, bucket);
  }

  console.log('=== Usage vs estimatedInputTokens analysis (offline) ===');
  console.log('Base directory:', BASE_DIR);
  console.log('Total samples with upstream+estimated input:', total);
  console.log('Samples with previous different-provider call:', withPrev);
  console.log('Would override (prefer our estimate):', overrideCount);
  console.log('');
  console.log('Per-provider overview:');
  for (const [providerKey, stats] of perProvider.entries()) {
    const ratio =
      stats.total > 0 ? (stats.overrides / stats.total * 100).toFixed(1) : '0.0';
    console.log(
      `  - ${providerKey}: total=${stats.total}, overrides=${stats.overrides} (${ratio}%)`
    );
  }
}

main();
