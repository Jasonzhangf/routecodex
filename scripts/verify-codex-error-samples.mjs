#!/usr/bin/env node

/**
 * Lightweight regression guard for previously captured Codex error样本.
 *
 * 目标：
 * - 扫描 ~/.routecodex/errorsamples 目录下的 *.json 文件；
 * - 如果仍包含已知错误模式（例如 exec_command 参数解析失败、apply_patch 验证失败），则视为回归；
 * - 目录不存在或为空时直接跳过（不影响构建）。
 *
 * 注意：
 * - 该脚本只是“错误字符串回归检测”，不会主动重放请求；
 * - 每当修复一批问题后，应将修复后的样本覆盖到 ~/.routecodex/errorsamples，再由本脚本做守护。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT =
  process.env.ROUTECODEX_ERROR_SAMPLES_DIR &&
  process.env.ROUTECODEX_ERROR_SAMPLES_DIR.trim().length
    ? path.resolve(process.env.ROUTECODEX_ERROR_SAMPLES_DIR)
    : path.join(os.homedir(), '.routecodex', 'errorsamples');

const ERROR_PATTERNS = [
  'failed to parse exec_command arguments',
  'apply_patch verification failed'
];

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function collectSampleFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    files.push(path.join(rootDir, entry.name));
  }
  return files;
}

async function checkFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const hits = [];
  for (const pattern of ERROR_PATTERNS) {
    if (raw.includes(pattern)) {
      hits.push(pattern);
    }
  }
  return hits;
}

async function main() {
  if (!(await fileExists(ROOT))) {
    console.log(`[verify:errorsamples] skip (directory not found: ${ROOT})`);
    return;
  }

  const files = await collectSampleFiles(ROOT);
  if (!files.length) {
    console.log(`[verify:errorsamples] skip (no *.json samples under ${ROOT})`);
    return;
  }

  console.log(`[verify:errorsamples] scanning ${files.length} sample(s) under ${ROOT}`);

  const failures = [];
  for (const file of files) {
    const hits = await checkFile(file);
    if (hits.length) {
      failures.push({ file, hits });
    }
  }

  if (!failures.length) {
    console.log('[verify:errorsamples] ✅ no known error patterns found');
    return;
  }

  console.error('[verify:errorsamples] ❌ detected legacy error patterns in samples:');
  for (const item of failures) {
    console.error(` - ${path.basename(item.file)} → ${item.hits.join(', ')}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('[verify:errorsamples] failed:', error);
  process.exit(99);
});
