#!/usr/bin/env node

/**
 * Scan ~/.routecodex/codex-samples for apply_patch usage and
 * count successful vs failed invocations.
 *
 * We look for apply_patch tool *results* in any JSON snapshot:
 * - Gemini-style functionResponse.response.result
 * - OpenAI-style tool_result with name === "apply_patch"
 *
 * Classification:
 * - validationFailure: message contains "apply_patch verification failed"
 * - executionFailure: message contains generic "failed"/"error"/"exception"
 *   but not the verification pattern
 * - success: there is a result string and it doesn't look like a failure
 * - unknown: no textual result payload
 *
 * Note: counts are per snapshot occurrence, not de-duplicated by requestId.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const ROOT = path.join(HOME, '.routecodex', 'codex-samples');
const ENTRIES = ['openai-responses', 'openai-chat', 'anthropic-messages'];

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
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        yield full;
      }
    }
  }
}

function extractApplyPatchResults(doc) {
  const results = [];

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    const any = node;

    // Gemini-style: functionResponse { name: "apply_patch", response: { result: "..." } }
    if (any.name === 'apply_patch' && any.response && typeof any.response === 'object') {
      const resp = any.response;
      let text = '';
      if (typeof resp.result === 'string') {
        text = resp.result;
      } else if (typeof resp.output === 'string') {
        text = resp.output;
      }
      results.push({ kind: 'result', text });
    }

    // OpenAI-style tool_result: { type: "tool_result", name: "apply_patch", result/output: ... }
    if (any.type === 'tool_result' && any.name === 'apply_patch') {
      let text = '';
      if (typeof any.result === 'string') {
        text = any.result;
      } else if (typeof any.output === 'string') {
        text = any.output;
      } else if (Array.isArray(any.output)) {
        text = any.output
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object') {
              if (typeof entry.text === 'string') return entry.text;
              if (typeof entry.content === 'string') return entry.content;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      results.push({ kind: 'result', text });
    }

    // Function-call style apply_patch invocation
    if (
      (any.type === 'function_call' || any.type === 'functionCall') &&
      any.name === 'apply_patch'
    ) {
      results.push({ kind: 'call', text: '' });
    }

    // Provider tool_calls: { function: { name: "apply_patch", ... } }
    if (any.function && typeof any.function === 'object' && any.function.name === 'apply_patch') {
      results.push({ kind: 'call', text: '' });
    }

    for (const value of Object.values(any)) {
      visit(value);
    }
  }

  visit(doc);
  return results;
}

function classifyResultText(text) {
  if (!text || typeof text !== 'string') {
    return 'unknown';
  }
  const lower = text.toLowerCase();
  if (text.includes('apply_patch verification failed')) {
    return 'validationFailure';
  }
  if (lower.includes('verification failed')) {
    return 'validationFailure';
  }
  if (lower.includes('failed') || lower.includes('error') || lower.includes('exception')) {
    return 'executionFailure';
  }
  return 'success';
}

async function main() {
  if (!(await fileExists(ROOT))) {
    console.error('[analyze-apply-patch-samples] codex-samples not found at', ROOT);
    process.exit(0);
  }

  const totals = {
    filesScanned: 0,
    calls: 0,
    results: 0,
    success: 0,
    validationFailure: 0,
    executionFailure: 0,
    unknown: 0
  };

  const byEntry = {};

  for (const entry of ENTRIES) {
    const entryDir = path.join(ROOT, entry);
    if (!(await fileExists(entryDir))) {
      continue;
    }
    const stats = {
      filesScanned: 0,
      calls: 0,
      results: 0,
      success: 0,
      validationFailure: 0,
      executionFailure: 0,
      unknown: 0
    };

    for await (const filePath of walkJsonFiles(entryDir)) {
      stats.filesScanned += 1;
      totals.filesScanned += 1;
      let doc;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        doc = JSON.parse(raw);
      } catch {
        continue;
      }
      const results = extractApplyPatchResults(doc);
      if (!results.length) continue;

      for (const item of results) {
        if (item.kind === 'call') {
          stats.calls += 1;
          totals.calls += 1;
          continue;
        }
        if (item.kind === 'result') {
          stats.results += 1;
          totals.results += 1;
          const bucket = classifyResultText(item.text);
          if (bucket === 'success') {
            stats.success += 1;
            totals.success += 1;
          } else if (bucket === 'validationFailure') {
            stats.validationFailure += 1;
            totals.validationFailure += 1;
          } else if (bucket === 'executionFailure') {
            stats.executionFailure += 1;
            totals.executionFailure += 1;
          } else {
            stats.unknown += 1;
            totals.unknown += 1;
          }
        }
      }
    }

    byEntry[entry] = stats;
  }

  console.log('[analyze-apply-patch-samples] summary (per snapshot, not de-duplicated by reqId):');
  console.log(
    `TOTAL files=${totals.filesScanned}, calls=${totals.calls}, results=${totals.results},` +
      ` success=${totals.success}, validationFailure=${totals.validationFailure},` +
      ` executionFailure=${totals.executionFailure}, unknown=${totals.unknown}`
  );
  for (const [entry, s] of Object.entries(byEntry)) {
    console.log(
      `${entry}: files=${s.filesScanned}, calls=${s.calls}, results=${s.results},` +
        ` success=${s.success}, validationFailure=${s.validationFailure},` +
        ` executionFailure=${s.executionFailure}, unknown=${s.unknown}`
    );
  }
}

main().catch((error) => {
  console.error('[analyze-apply-patch-samples] failed:', error);
  process.exit(1);
});

