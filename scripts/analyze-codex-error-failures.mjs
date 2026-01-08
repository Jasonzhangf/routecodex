#!/usr/bin/env node

/**
 * Analyze failures in ~/.routecodex/codex-samples to understand
 * which error patterns出现频率最高，以及哪些适合作为“可修复”样本。
 *
 * 当前只做静态统计，不修改任何样本：
 * - 扫描 openai-responses 下所有 *.json；
 * - 抓取以下错误字符串：
 *   - "apply_patch verification failed"
 *   - "failed to parse exec_command arguments"
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
  'failed to parse exec_command arguments',
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

async function listJsonFiles(root) {
  const entries = await fs.readdir(root);
  return entries
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => path.join(root, name));
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

  const files = await listJsonFiles(RESPONSES_DIR);
  if (!files.length) {
    console.log('[analyze-codex-error-failures] no JSON files under', RESPONSES_DIR);
    process.exit(0);
  }

  console.log(`[analyze-codex-error-failures] scanning ${files.length} file(s) under ${RESPONSES_DIR}`);

  const summary = new Map();
  for (const p of PATTERNS) {
    summary.set(p, { count: 0, files: [] });
  }

  for (const file of files) {
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
  }

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
