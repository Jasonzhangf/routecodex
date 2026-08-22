#!/usr/bin/env node

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
  'failed to parse function arguments: missing field `cmd`',
  'failed to parse function arguments: missing field `input`',
  'failed to parse function arguments: missing field `command`',
  'invalid type: map, expected a string'
];

const APPLY_PATCH_SHAPE_PATTERNS = [
  'invalid patch',
  'failed to parse',
  'missing field `input`',
  'missing field `cmd`',
  'missing field `command`',
  'invalid type: map, expected a string'
];

const APPLY_PATCH_NON_SHAPE_PATTERNS = [
  'failed to find context',
  'failed to find expected lines',
  'failed to read file',
  'no such file',
  'file not found'
];

function isJsonFile(name) {
  return name.toLowerCase().endsWith('.json');
}

async function exists(p) {
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

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) continue;

    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isJsonFile(entry.name)) continue;
      files.push(fullPath);
    }
  }

  return files.sort();
}

function classifySample(raw) {
  const lower = raw.toLowerCase();

  const shapeHits = SHAPE_ERROR_PATTERNS.filter((pattern) => raw.includes(pattern));
  if (shapeHits.length > 0) {
    return { kind: 'shape', hits: shapeHits };
  }

  if (lower.includes('apply_patch verification failed')) {
    const shapeMatched = APPLY_PATCH_SHAPE_PATTERNS.filter((needle) => lower.includes(needle));
    if (shapeMatched.length > 0) {
      return { kind: 'shape', hits: ['apply_patch verification failed (shape)'] };
    }
    const nonShapeMatched = APPLY_PATCH_NON_SHAPE_PATTERNS.filter((needle) => lower.includes(needle));
    if (nonShapeMatched.length > 0) {
      return { kind: 'non_shape', hits: ['apply_patch verification failed (context/non-shape)'] };
    }
    return { kind: 'non_shape', hits: ['apply_patch verification failed (unknown subtype)'] };
  }

  return { kind: 'none', hits: [] };
}

function inIgnoredSubdir(filePath) {
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.includes(SKIP_SUBDIR) || parts.includes(GOLD_SUBDIR);
}

async function moveIntoSkip(filePath) {
  const rel = path.relative(ROOT, filePath);
  const target = path.join(ROOT, SKIP_SUBDIR, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(filePath, target);
  return target;
}

async function moveIntoGold(filePath) {
  const rel = path.relative(ROOT, filePath);
  const target = path.join(ROOT, GOLD_SUBDIR, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(filePath, target);
  return target;
}

async function main() {
  const apply = process.argv.includes('--apply');

  if (!(await exists(ROOT))) {
    console.log(`[triage:errorsamples] skip (directory not found: ${ROOT})`);
    return;
  }

  const files = await collectSampleFiles(ROOT);
  if (!files.length) {
    console.log(`[triage:errorsamples] skip (no *.json samples under ${ROOT})`);
    return;
  }

  const shape = [];
  const nonShape = [];
  for (const file of files) {
    if (inIgnoredSubdir(file)) {
      continue;
    }
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const classified = classifySample(raw);
    if (classified.kind === 'shape') {
      shape.push({ file, hits: classified.hits });
    } else if (classified.kind === 'non_shape') {
      nonShape.push({ file, hits: classified.hits });
    }
  }

  console.log(`[triage:errorsamples] scanned: ${files.length}`);
  console.log(`[triage:errorsamples] shape/actionable: ${shape.length}`);
  console.log(`[triage:errorsamples] non-shape/skip-candidate: ${nonShape.length}`);

  if (shape.length > 0) {
    console.log('[triage:errorsamples] actionable shape samples (move to gold regression set):');
    for (const item of shape.slice(0, 20)) {
      console.log(` - ${path.basename(item.file)} → ${item.hits.join(', ')}`);
    }
    if (shape.length > 20) {
      console.log(` - ... and ${shape.length - 20} more`);
    }
  }

  if (!apply) {
    console.log(`[triage:errorsamples] dry-run complete (pass --apply to move shape -> ${GOLD_SUBDIR}/ and non-shape -> ${SKIP_SUBDIR}/)`);
    return;
  }

  let movedGold = 0;
  for (const item of shape) {
    try {
      await moveIntoGold(item.file);
      movedGold += 1;
    } catch {
      // best-effort
    }
  }

  let movedSkip = 0;
  for (const item of nonShape) {
    try {
      await moveIntoSkip(item.file);
      movedSkip += 1;
    } catch {
      // best-effort
    }
  }
  console.log(`[triage:errorsamples] moved to ${GOLD_SUBDIR}/: ${movedGold}/${shape.length}`);
  console.log(`[triage:errorsamples] moved to ${SKIP_SUBDIR}/: ${movedSkip}/${nonShape.length}`);
}

main().catch((error) => {
  console.error('[triage:errorsamples] failed:', error);
  process.exit(99);
});
