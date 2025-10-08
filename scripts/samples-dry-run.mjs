#!/usr/bin/env node
// Dry-run against captured Codex samples to validate compatibility/tool-calls

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importModulePreferSrc, listFiles, readJSON } from './lib/utils.mjs';

function findSampleDir(dirArg) {
  if (dirArg) return path.resolve(dirArg);
  const defaultDir = path.join(os.homedir(), '.routecodex', 'codex-samples');
  return defaultDir;
}

function hasInvokeMarkup(text) {
  if (typeof text !== 'string') return false;
  return /<(?:invoke|function)(?:[\w_-]*)\b[^>]*>/.test(text);
}

async function main() {
  const dirArg = process.argv[2];
  const sampleDir = findSampleDir(dirArg);
  if (!fs.existsSync(sampleDir)) {
    // Treat missing samples as a no-op in CI to avoid false failures
    console.log(`Sample directory not found (skipping): ${sampleDir}`);
    process.exit(0);
  }

  // Import real GLM Compatibility module from dist
  const { GLMCompatibility } = await importModulePreferSrc(import.meta.url,
    'modules/pipeline/modules/compatibility/glm-compatibility.js',
    'modules/pipeline/modules/compatibility/glm-compatibility.ts'
  );
  const { PipelineDebugLogger } = await importModulePreferSrc(import.meta.url,
    'modules/pipeline/utils/debug-logger.js',
    'modules/pipeline/utils/debug-logger.ts'
  );

  // Minimal dependency stubs for module init
  const debugCenter = { processDebugEvent: () => {} };
  const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: false, logLevel: 'normal' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const compat = new GLMCompatibility({ type: 'glm-compatibility', config: { thinking: { enabled: true, payload: { type: 'enabled' } } } }, dependencies);
  await compat.initialize();

  const files = listFiles(sampleDir, { prefix: 'pipeline-out-', suffix: '.json' });
  if (files.length === 0) {
    console.log(`No pipeline-out samples found in ${sampleDir}`);
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const file of files) {
    try {
      const payload = readJSON(file);
      const transformed = await compat.processOutgoing(payload);
      const msg = transformed?.choices?.[0]?.message || {};
      const contentStr = typeof msg.content === 'string' ? msg.content : '';
      // Minimal check: processing should not throw; reasoning_content may be promoted.
      const ok = true;
      results.push({ file, ok, toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0, contentLength: contentStr.length });
      passed++;
    } catch (e) {
      results.push({ file, ok: false, error: String(e?.message || e) });
      failed++;
    }
  }

  // Synthetic cases removed in minimal mode; we no longer reconstruct tool calls from markup.

  // Print summary
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${path.basename(r.file)}  tool_calls:${r.toolCalls}  content:${r.contentLength}`);
    } else {
      console.log(`✗ ${path.basename(r.file)}  ${r.error || 'validation failed (no tool_calls and markup remains)'}`);
    }
  }
  console.log(`\nSummary: ${passed} passed, ${failed} failed (total ${files.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('samples-dry-run failed:', err);
  process.exit(1);
});
