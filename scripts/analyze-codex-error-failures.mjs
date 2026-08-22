#!/usr/bin/env node

/**
 * Analyze failures in ~/.routecodex/codex-samples to understand
 * which error patterns出现频率最高，以及哪些适合作为“可修复”样本。
 *
 * 当前只做静态统计，不修改任何样本：
 * - 扫描 openai-responses 下所有 *.json；
 * - 抓取以下错误字符串：
 *   - "apply_patch verification failed"
 *   - "failed to parse function arguments: missing field `cmd`"
 *   - "failed to parse function arguments: missing field `input`"
 *   - "Instructions are not valid"
 * - 输出每种模式的命中次数和示例文件列表。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const RESPONSES_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-responses');

const PATTERNS = [
  'apply_patch verification failed',
  'failed to parse function arguments: missing field `cmd`',
  'failed to parse function arguments: missing field `input`',
  'Instructions are not valid'
];

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

async function analyzeFile(filePath) {
  const text = await fs.readFile(filePath, 'utf-8');
  const hits = [];
  for (const key of PATTERNS) {
    if (text.includes(key)) {
      hits.push(key);
    }
  }
  return { filePath, hits };
}

async function main() {
  if (!(await fileExists(RESPONSES_DIR))) {
    console.error('[analyze-codex-error-failures] no codex-samples at', RESPONSES_DIR);
    process.exit(0);
  }

  const summary = new Map();
  for (const p of PATTERNS) {
    summary.set(p, { count: 0, files: [] });
  }

  let scanned = 0;
  for await (const file of walkJsonFiles(RESPONSES_DIR)) {
    let res;
    try {
      res = await analyzeFile(file);
    } catch {
      continue;
    }
    if (!res.hits.length) continue;
    for (const key of res.hits) {
      const entry = summary.get(key);
      if (!entry) continue;
      entry.count += 1;
      if (entry.files.length < 10) {
        entry.files.push(path.basename(file));
      }
    }
    scanned += 1;
  }

  console.log(`[analyze-codex-error-failures] scanned ${scanned} file(s) under ${RESPONSES_DIR}`);

  for (const key of PATTERNS) {
    const { count, files } = summary.get(key);
    console.log(`\n=== Pattern: "${key}" ===`);
    console.log(`count: ${count}`);
    if (files.length) {
      console.log('examples:');
      for (const f of files) {
        console.log(`  - ${f}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('[analyze-codex-error-failures] failed:', error);
  process.exit(99);
});
