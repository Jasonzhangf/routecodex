#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const RESPONSES_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-responses');

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
    if (typeof node !== 'object') return;
    const any = node;

    if (any.name === 'apply_patch' && any.response && typeof any.response === 'object') {
      const resp = any.response;
      let text = '';
      if (typeof resp.result === 'string') text = resp.result;
      else if (typeof resp.output === 'string') text = resp.output;
      results.push(text);
    }

    if (any.type === 'tool_result' && any.name === 'apply_patch') {
      let text = '';
      if (typeof any.result === 'string') text = any.result;
      else if (typeof any.output === 'string') text = any.output;
      else if (Array.isArray(any.output)) {
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
      results.push(text);
    }

    for (const value of Object.values(any)) visit(value);
  }
  visit(doc);
  return results;
}

function isExecutionFailure(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  if (text.includes('apply_patch verification failed')) return false;
  if (!lower.includes('failed') && !lower.includes('error') && !lower.includes('exception')) return false;
  return true;
}

function normalizeKey(text) {
  if (!text) return '<empty>'; 
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
}

async function main() {
  if (!(await fileExists(RESPONSES_DIR))) {
    console.error('[analyze-apply-patch-exec-failures] no openai-responses dir at', RESPONSES_DIR);
    process.exit(0);
  }

  const byKey = new Map();
  let total = 0;

  for await (const filePath of walkJsonFiles(RESPONSES_DIR)) {
    let doc;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    const results = extractApplyPatchResults(doc);
    if (!results.length) continue;
    for (const text of results) {
      if (!isExecutionFailure(text)) continue;
      total += 1;
      const key = normalizeKey(text);
      const current = byKey.get(key) || { count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) {
        current.examples.push(path.basename(filePath));
      }
      byKey.set(key, current);
    }
  }

  console.log(`[analyze-apply-patch-exec-failures] total execution-like failures: ${total}`);

  const sorted = Array.from(byKey.entries()).sort((a, b) => b[1].count - a[1].count);
  const top = sorted.slice(0, 30);

  for (const [key, value] of top) {
    console.log('\n--- pattern ---');
    console.log(`count=${value.count}`);
    console.log(`firstLine=${JSON.stringify(key)}`);
    if (value.examples.length) {
      console.log('examples:');
      for (const ex of value.examples) {
        console.log(`  - ${ex}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('[analyze-apply-patch-exec-failures] failed:', err);
  process.exit(1);
});

