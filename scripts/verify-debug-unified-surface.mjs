#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const failures = [];

function readRepoFile(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function repoFileExists(path) {
  return existsSync(resolve(ROOT, path));
}

function nonCommentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/**') || line.startsWith('*/')) return false;
      return true;
    });
}

function assertShellOnly(path, expectedExportA, expectedExportB) {
  const text = readRepoFile(path);
  const lines = nonCommentLines(text);
  if (lines.length !== 1 || (lines[0] !== expectedExportA && lines[0] !== expectedExportB)) {
    failures.push(`${path} must stay a one-line re-export shell to the unified debug surface (got ${lines.length} non-comment lines: ${JSON.stringify(lines)})`);
  }
}

function assertNotContains(path, forbiddenPatterns) {
  const text = readRepoFile(path);
  for (const pattern of forbiddenPatterns) {
    if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
      failures.push(`${path} contains forbidden debug-unified residue: ${pattern}`);
    }
  }
}

function listFilesRecursive(dir) {
  const root = resolve(ROOT, dir);
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = resolve(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      out.push(full.slice(ROOT.length + 1));
    }
  }
  return out.sort();
}

const responsesHandler = readRepoFile('src/server/handlers/responses-handler.ts');
const replayScript = readRepoFile('scripts/debug/replay-live-minimax-2013.mjs');

if (responsesHandler.includes("'.rcc', 'diag'") || responsesHandler.includes('fs.writeFileSync(path.join(diagDir')) {
  failures.push('responses-handler.ts still contains ad hoc ~/.rcc/diag file-writing logic');
}
if (!responsesHandler.includes('writeDebugErrorDiagArtifact')) {
  failures.push('responses-handler.ts no longer references the unified debug diag writer');
}
if (replayScript.includes('/Users/fanzhang/.rcc/diag/')) {
  failures.push('replay-live-minimax-2013.mjs still hardcodes a local-machine diag path');
}
if (!replayScript.includes('readDebugErrorDiagArtifact') || !replayScript.includes('process.argv[2]')) {
  failures.push('replay-live-minimax-2013.mjs is not reading diag artifacts through the unified reader + explicit CLI path');
}

const debugIndex = readRepoFile('src/debug/index.ts');
for (const requiredExport of [
  "export * from './diag/index.js';",
  "export * from './snapshot/index.js';",
  "export * from './logger/index.js';",
  "export * from './hooks/index.js';",
  "export * from './policy/index.js';"
]) {
  if (!debugIndex.includes(requiredExport)) {
    failures.push(`src/debug/index.ts missing ${requiredExport}`);
  }
}

const snapshotWriter = readRepoFile('src/debug/snapshot/writer.ts');
if (!snapshotWriter.includes('writeUnifiedSnapshot') || !snapshotWriter.includes('createSnapshotWriter')) {
  failures.push('src/debug/snapshot/writer.ts must expose writeUnifiedSnapshot and createSnapshotWriter');
}
if (!snapshotWriter.includes('fsp.writeFile')) {
  failures.push('src/debug/snapshot/writer.ts must own the canonical snapshot file write');
}

assertShellOnly(
  'src/utils/snapshot-writer.ts',
  "export * from '../debug/snapshot/server-writer.js';",
  'export * from "../debug/snapshot/server-writer.js";'
);
assertShellOnly(
  'src/providers/core/utils/snapshot-writer.ts',
  "export * from '../../../debug/snapshot/provider-writer.js';",
  'export * from "../../../debug/snapshot/provider-writer.js";'
);
assertShellOnly(
  'src/modules/pipeline/utils/debug-logger.ts',
  "export * from '../../../debug/logger/pipeline.js';",
  'export * from "../../../debug/logger/pipeline.js";'
);
assertShellOnly(
  'src/modules/pipeline/utils/colored-logger.ts',
  "export * from '../../../debug/logger/colored.js';",
  'export * from "../../../debug/logger/colored.js";'
);
assertShellOnly(
  'src/providers/core/hooks/debug-example-hooks.ts',
  "export * from '../../../debug/hooks/example-hooks.js';",
  'export * from "../../../debug/hooks/example-hooks.js";'
);
assertShellOnly(
  'src/providers/core/config/provider-debug-hooks.ts',
  "export * from '../../../debug/hooks/bidirectional.js';",
  'export * from "../../../debug/hooks/bidirectional.js";'
);

if (repoFileExists('src/providers/core/utils/snapshot-writer-buffer.ts')) {
  failures.push('src/providers/core/utils/snapshot-writer-buffer.ts must stay physically deleted; owner is src/debug/snapshot/buffer.ts');
}

assertNotContains('src/debug/snapshot/provider-writer.ts', [
  'writeSnapshotViaHooks',
  'fsp.writeFile',
  'writeUniqueFile',
  'mirrorSnapshotToLocalDisk',
  'writeCanonicalSnapshotFileIfMissing',
  'canWriteSnapshotToLocalDisk',
  'ensureSnapshotRuntimeMarker',
  'pruneSnapshotRequestDirsKeepRecent',
  'fallbackWrite',
]);

for (const file of [
  'src/utils/snapshot-writer.ts',
  'src/providers/core/utils/snapshot-writer.ts',
  'src/modules/pipeline/utils/debug-logger.ts',
  'src/modules/pipeline/utils/colored-logger.ts',
  'src/providers/core/hooks/debug-example-hooks.ts',
  'src/providers/core/config/provider-debug-hooks.ts',
]) {
  assertNotContains(file, [
    'fs/promises',
    'node:fs',
    'writeSnapshotViaHooks',
    'class ',
    'function ',
    'runtimeFlags',
    'process.env',
  ]);
}

const removedDebugFlatFiles = [
  'src/debug/harness-registry.ts',
  'src/debug/dry-runner.ts',
  'src/debug/replay-runner.ts',
  'src/debug/default-harnesses.ts',
  'src/debug/harnesses/provider-harness.ts',
];
for (const file of removedDebugFlatFiles) {
  if (repoFileExists(file)) {
    failures.push(`${file} must stay physically deleted after harness migration`);
  }
}

const debugFiles = listFilesRecursive('src/debug');
const allowedFileWriteOwners = new Set([
  'src/debug/snapshot/writer.ts',
  'src/debug/diag/error-artifact.ts',
  'src/debug/policy/violations.ts',
  'src/debug/snapshot-store.ts',
]);
const providerWriterFilesWithFileWrites = debugFiles.filter((file) => {
  if (!file.endsWith('.ts')) return false;
  const text = readRepoFile(file);
  const stripped = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.includes('fsp.writeFile') || stripped.includes('fs.writeFile') || stripped.includes('fsp.mkdir');
});
for (const file of providerWriterFilesWithFileWrites) {
  if (!allowedFileWriteOwners.has(file)) {
    failures.push(`${file} contains direct debug file writes outside approved unified snapshot/diag/store owners`);
  }
}

const serverWriterText = readRepoFile('src/debug/snapshot/server-writer.ts');
const serverWriterStripped = serverWriterText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (serverWriterStripped.includes('fsp.') || serverWriterStripped.includes('fs.writeFileSync') || serverWriterStripped.includes('writeSnapshotViaHooks')) {
  failures.push('src/debug/snapshot/server-writer.ts must delegate all writes to src/debug/snapshot/writer.ts');
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[verify-debug-unified-surface] ${failure}`);
  }
  process.exit(1);
}

console.log('[verify-debug-unified-surface] PASS');
