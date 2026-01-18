#!/usr/bin/env node

/**
 * Backfill apply_patch execution failures into ~/.routecodex/errorsamples/apply_patch_exec/**.
 *
 * Source: ~/.routecodex/codex-samples/** (stage snapshots)
 * Signal: tool role message name=apply_patch and content includes "apply_patch verification failed".
 *
 * This is a best-effort collector for debugging. It does NOT attempt any semantic repair.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = os.homedir();
const CODEX_ROOT_PRIMARY = path.join(HOME, '.routecodex', 'codex-samples');
const CODEX_ROOT_ALT = path.join(HOME, '.routecodex', 'codex samples');

const ERR_BASE =
  process.env.ROUTECODEX_ERRORSAMPLES_DIR && process.env.ROUTECODEX_ERRORSAMPLES_DIR.trim().length
    ? path.resolve(process.env.ROUTECODEX_ERRORSAMPLES_DIR)
    : path.join(HOME, '.routecodex', 'errorsamples');
const OUT_ROOT = path.join(ERR_BASE, 'apply_patch_exec');

const MAX_PER_TYPE = 250;

function detectApplyPatchToolMode() {
  return 'freeform';
}

function classifyExecutionFailure(content) {
  const raw = String(content || '');
  const trimmed = raw.trim();
  const prefix = 'apply_patch verification failed:';
  const msg = trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
  const lower = msg.toLowerCase();

  if (lower.includes('failed to read file')) return { errorType: 'read_file_failed', message: msg };
  if (lower.includes('no such file') || lower.includes('file not found')) return { errorType: 'file_not_found', message: msg };
  if (lower.includes('failed to find context')) return { errorType: 'context_not_found', message: msg };
  if (lower.includes('failed to find expected lines')) return { errorType: 'expected_lines_not_found', message: msg };
  if (lower.includes('invalid patch')) return { errorType: 'invalid_patch', message: msg };
  if (lower.includes('failed to parse')) return { errorType: 'parse_failed', message: msg };

  return { errorType: 'unknown', message: msg };
}

function stableId({ errorType, errorMessage, toolCallId, toolCallArgs, requestId, mode }) {
  const key = `${String(errorType)}:${String(errorMessage)}:${String(toolCallId || '')}:${String(toolCallArgs || '')}:${String(
    requestId || ''
  )}:${String(mode || '')}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function* walkJsonFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) yield full;
    }
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function countJsonFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function buildToolCallArgsIndex(messages) {
  const map = new Map();
  for (const msg of messages) {
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    for (const tc of toolCalls) {
      const id = typeof tc?.id === 'string' ? tc.id : '';
      const fn = tc?.function;
      const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
      if (!id || name !== 'apply_patch') continue;
      const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
      if (args) map.set(id, args);
    }
  }
  return map;
}

async function main() {
  const roots = [];
  if (await fileExists(CODEX_ROOT_PRIMARY)) roots.push(CODEX_ROOT_PRIMARY);
  if (await fileExists(CODEX_ROOT_ALT)) roots.push(CODEX_ROOT_ALT);

  if (!roots.length) {
    console.log('[backfill:apply_patch_exec] skip (no codex-samples root found)');
    return;
  }

  await ensureDir(OUT_ROOT);

  const mode = detectApplyPatchToolMode();

  let scanned = 0;
  let matchedFiles = 0;
  let captured = 0;
  let skippedLimit = 0;
  let skippedExists = 0;

  for (const root of roots) {
    for await (const file of walkJsonFiles(root)) {
      scanned += 1;
      if (!file.endsWith('req_process_stage1_tool_governance.json')) continue;

      let doc;
      try {
        doc = JSON.parse(await fs.readFile(file, 'utf-8'));
      } catch {
        continue;
      }

      const messages = Array.isArray(doc?.messages) ? doc.messages : [];
      if (!messages.length) continue;

      const toolCallArgsById = buildToolCallArgsIndex(messages);

      const toolMsgs = messages.filter(
        (m) =>
          m &&
          m.role === 'tool' &&
          String(m.name || '').trim().toLowerCase() === 'apply_patch' &&
          typeof m.content === 'string' &&
          m.content.toLowerCase().includes('apply_patch verification failed')
      );
      if (!toolMsgs.length) continue;

      matchedFiles += 1;

      const metadata = doc?.metadata || {};
      const requestId = typeof metadata?.requestId === 'string' ? metadata.requestId : undefined;
      const entryEndpoint = typeof metadata?.originalEndpoint === 'string' ? metadata.originalEndpoint : undefined;
      const providerKey = typeof metadata?.providerKey === 'string' ? metadata.providerKey : undefined;
      const modelId = typeof doc?.model === 'string' ? doc.model : undefined;

      for (const m of toolMsgs) {
        const { errorType, message } = classifyExecutionFailure(m.content);
        const safeType = String(errorType || 'unknown').replace(/[^a-z0-9-]/gi, '_');
        const typeDir = path.join(OUT_ROOT, safeType);
        await ensureDir(typeDir);

        const currentCount = await countJsonFiles(typeDir);
        if (currentCount >= MAX_PER_TYPE) {
          skippedLimit += 1;
          continue;
        }

        const toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
        const toolCallArgs = toolCallId ? toolCallArgsById.get(toolCallId) : undefined;
        const id = `sample_${stableId({
          errorType,
          errorMessage: message,
          toolCallId,
          toolCallArgs,
          requestId,
          mode
        })}`;
        const outPath = path.join(typeDir, `${id}.json`);

        if (await fileExists(outPath)) {
          skippedExists += 1;
          continue;
        }

        const payload = {
          id,
          timestamp: new Date().toISOString(),
          errorType,
          errorMessage: message,
          toolCallId,
          toolCallArgs,
          requestId,
          entryEndpoint,
          providerKey,
          model: modelId,
          source: 'codex-samples:req_process_stage1_tool_governance',
          meta: { applyPatchToolMode: mode, sourceFile: file }
        };
        await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
        captured += 1;
      }
    }
  }

  console.log(
    `[backfill:apply_patch_exec] scanned=${scanned} matchedFiles=${matchedFiles} captured=${captured} skippedExists=${skippedExists} skippedLimit=${skippedLimit} out=${OUT_ROOT}`
  );
}

main().catch((err) => {
  console.error('[backfill:apply_patch_exec] failed:', err?.stack || err?.message || String(err));
  process.exit(2);
});
