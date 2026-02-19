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
const SKIP_SUBDIR = (() => {
  const raw = String(process.env.ROUTECODEX_ERROR_SAMPLES_SKIP_SUBDIR || '').trim();
  return raw || 'skip';
})();
const GOLD_SUBDIR = (() => {
  const raw = String(process.env.ROUTECODEX_ERROR_SAMPLES_GOLD_SUBDIR || '').trim();
  return raw || 'gold';
})();

const SHAPE_ERROR_PATTERNS = [
  // exec_command / shell_command / apply_patch 参数形状错误
  'failed to parse function arguments: missing field `cmd`',
  'failed to parse function arguments: missing field `input`',
  'failed to parse function arguments: missing field `command`',
  'invalid type: map, expected a string'
];

const APPLY_PATCH_SHAPE_PATTERNS = [
  // apply_patch 仍属于“可修复形状问题”的子类
  'invalid patch',
  'failed to parse',
  'missing field `input`',
  'missing field `cmd`',
  'missing field `command`',
  'invalid type: map, expected a string'
];

const APPLY_PATCH_NON_SHAPE_PATTERNS = [
  // 这些是上下文/执行问题，不应作为“形状回归”阻塞构建
  'failed to find context',
  'failed to find expected lines',
  'failed to read file',
  'no such file',
  'file not found'
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
  const files = [];
  const queue = [rootDir];
  const skippedDirs = [];
  const goldDirs = [];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === SKIP_SUBDIR) {
          skippedDirs.push(fullPath);
          continue;
        }
        if (entry.name === GOLD_SUBDIR) {
          goldDirs.push(fullPath);
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      files.push(fullPath);
    }
  }

  return {
    files: files.sort(),
    skippedDirs,
    goldDirs
  };
}

async function checkFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const lower = raw.toLowerCase();
  const failHits = [];
  const warnHits = [];

  for (const pattern of SHAPE_ERROR_PATTERNS) {
    if (raw.includes(pattern)) {
      failHits.push(pattern);
    }
  }

  if (lower.includes('apply_patch verification failed')) {
    const shapeMatched = APPLY_PATCH_SHAPE_PATTERNS.some((needle) => lower.includes(needle));
    const nonShapeMatched = APPLY_PATCH_NON_SHAPE_PATTERNS.some((needle) => lower.includes(needle));
    if (shapeMatched) {
      failHits.push('apply_patch verification failed (shape)');
    } else if (nonShapeMatched) {
      warnHits.push('apply_patch verification failed (context/non-shape)');
    } else {
      warnHits.push('apply_patch verification failed (unknown subtype)');
    }
  }

  return { failHits, warnHits };
}

async function main() {
  if (!(await fileExists(ROOT))) {
    console.log(`[verify:errorsamples] skip (directory not found: ${ROOT})`);
    return;
  }

  const { files, skippedDirs, goldDirs } = await collectSampleFiles(ROOT);
  if (!files.length) {
    console.log(`[verify:errorsamples] skip (no *.json samples under ${ROOT})`);
    return;
  }

  console.log(`[verify:errorsamples] scanning ${files.length} sample(s) under ${ROOT}`);
  if (skippedDirs.length > 0) {
    console.log(`[verify:errorsamples] skip subdir "${SKIP_SUBDIR}" (${skippedDirs.length} dir(s))`);
  }
  if (goldDirs.length > 0) {
    console.log(`[verify:errorsamples] gold subdir "${GOLD_SUBDIR}" (${goldDirs.length} dir(s))`);
  }

  const failures = [];
  const warnings = [];
  for (const file of files) {
    const { failHits, warnHits } = await checkFile(file);
    if (failHits.length) {
      failures.push({ file, hits: failHits });
    }
    if (warnHits.length) {
      warnings.push({ file, hits: warnHits });
    }
  }

  if (warnings.length > 0) {
    console.log(`[verify:errorsamples] warning-only samples: ${warnings.length}`);
    for (const item of warnings.slice(0, 8)) {
      console.log(` - ${path.basename(item.file)} → ${item.hits.join(', ')}`);
    }
    if (warnings.length > 8) {
      console.log(` - ... and ${warnings.length - 8} more warning sample(s)`);
    }
  }

  if (!failures.length) {
    console.log('[verify:errorsamples] ✅ no shape-error regressions found');
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
