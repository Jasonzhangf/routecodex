#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const responsesHandler = readFileSync(resolve(ROOT, 'src/server/handlers/responses-handler.ts'), 'utf8');
const replayScript = readFileSync(resolve(ROOT, 'scripts/debug/replay-live-minimax-2013.mjs'), 'utf8');

const failures = [];

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

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[verify-debug-unified-surface] ${failure}`);
  }
  process.exit(1);
}

console.log('[verify-debug-unified-surface] PASS');
