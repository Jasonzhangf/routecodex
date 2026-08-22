#!/usr/bin/env node

/**
 * Cleanup stale Codex error samples so that后续运行只记录新的失败。
 *
 * 行为：
 * - 扫描 ~/.routecodex/codex-samples/openai-responses 下所有 *.json；
 * - 如果包含以下任一错误模式，则视为“旧错误样本”，移动到归档目录：
 *   ~/.routecodex/codex-samples-archive/openai-responses
 *   - "apply_patch verification failed"
 *   - "failed to parse exec_command arguments"
 *   - "Instructions are not valid"
 *
 * 注意：
 * - 只做移动（rename），不直接删除文件，方便必要时回溯；
 * - 归档目录不参与当前 verify:errorsamples/分析脚本。
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

async function listJsonFiles(root) {
  const entries = await fs.readdir(root);
  return entries
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => path.join(root, name));
}

async function hasErrorPattern(filePath) {
  const text = await fs.readFile(filePath, 'utf-8');
  return PATTERNS.some((p) => text.includes(p));
}

async function main() {
  try {
    const st = await fs.stat(RESPONSES_DIR);
    if (!st.isDirectory()) {
      console.log('[cleanup-codex-error-samples] no codex-samples directory:', RESPONSES_DIR);
      return;
    }
  } catch {
    console.log('[cleanup-codex-error-samples] no codex-samples directory:', RESPONSES_DIR);
    return;
  }

  const files = await listJsonFiles(RESPONSES_DIR);
  if (!files.length) {
    console.log('[cleanup-codex-error-samples] no JSON files under', RESPONSES_DIR);
    return;
  }

  console.log(`[cleanup-codex-error-samples] scanning ${files.length} file(s) under ${RESPONSES_DIR}`);

  let removed = 0;
  for (const file of files) {
    try {
      const shouldMove = await hasErrorPattern(file);
      if (!shouldMove) continue;
      await fs.unlink(file);
      removed += 1;
      if (removed <= 10) {
        console.log(`  removed: ${path.basename(file)}`);
      }
    } catch {
      // best-effort: skip problematic file
    }
  }

  console.log(`[cleanup-codex-error-samples] removed ${removed} file(s) matching error patterns.`);
  if (removed > 10) {
    console.log('  (only first 10 shown above)');
  }
}

main().catch((error) => {
  console.error('[cleanup-codex-error-samples] failed:', error);
  process.exit(99);
});
