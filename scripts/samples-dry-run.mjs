#!/usr/bin/env node
// Dry-run against captured Codex samples to validate compatibility/tool-calls

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function importModulePreferSrc(relJs, relTs) {
  // Prefer src (run with tsx), fallback to dist
  try {
    const p = path.join(repoRoot, 'src', relTs);
    const href = url.pathToFileURL(p).href;
    return await import(href);
  } catch {
    const p = path.join(repoRoot, 'dist', relJs);
    const href = url.pathToFileURL(p).href;
    return await import(href);
  }
}

function findSampleDir(dirArg) {
  if (dirArg) return path.resolve(dirArg);
  const defaultDir = path.join(os.homedir(), '.routecodex', 'codex-samples');
  return defaultDir;
}

function listFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f))
    .sort();
}

function hasInvokeMarkup(text) {
  if (typeof text !== 'string') return false;
  return /<(?:invoke|function)(?:[\w_-]*)\b[^>]*>/.test(text);
}

async function main() {
  const dirArg = process.argv[2];
  const sampleDir = findSampleDir(dirArg);
  if (!fs.existsSync(sampleDir)) {
    console.error(`Sample directory not found: ${sampleDir}`);
    process.exit(2);
  }

  // Import real GLM Compatibility module from dist
  const { GLMCompatibility } = await importModulePreferSrc(
    'modules/pipeline/modules/compatibility/glm-compatibility.js',
    'modules/pipeline/modules/compatibility/glm-compatibility.ts'
  );
  const { PipelineDebugLogger } = await importModulePreferSrc(
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

  const files = listFiles(sampleDir, 'pipeline-out-');
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
      const before = JSON.parse(JSON.stringify(payload));
      const hasMarkup = (() => {
        try {
          const msg = before?.choices?.[0]?.message;
          const content = typeof msg?.content === 'string' ? msg.content : '';
          return hasInvokeMarkup(content);
        } catch { return false; }
      })();

      const transformed = await compat.processOutgoing(payload);
      const msg = transformed?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const contentStr = typeof msg.content === 'string' ? msg.content : '';

      const ok = toolCalls.length > 0 || (!hasMarkup && !hasInvokeMarkup(contentStr));
      results.push({ file, ok, toolCalls: toolCalls.length, contentLength: contentStr.length });
      if (ok) passed++; else failed++;
    } catch (e) {
      results.push({ file, ok: false, error: String(e?.message || e) });
      failed++;
    }
  }

  // Include synthetic cases to validate variant markup
  const synthCases = [
    { name: 'synthetic-bracket', content: "[tool_call:shell] {\"command\":[\"bash\",\"-lc\",\"echo hi\"]}" },
    { name: 'synthetic-function_call', content: "<function_call>{\"name\":\"shell\",\"arguments\":{\"command\":[\"bash\",\"-lc\",\"pwd\"]}}</function_call>" },
    { name: 'synthetic-think-wrap', content: "<think>private chain</think> Before [tool_call:shell] {\"command\":\"ls -la\"} After" },
    { name: 'synthetic-think-around-invoke', content: "<think>xxx</think><invoke name=\"shell\"><parameter name=\"command\">\"pwd\"</parameter></invoke>text" }
  ];
  for (const sc of synthCases) {
    try {
      const payload = { choices: [{ index: 0, message: { role: 'assistant', content: sc.content } }] };
      const transformed = await compat.processOutgoing(JSON.parse(JSON.stringify(payload)));
      const msg = transformed?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const contentStr = typeof msg.content === 'string' ? msg.content : '';
      const ok = toolCalls.length > 0 && !hasInvokeMarkup(contentStr);
      results.push({ file: sc.name, ok, toolCalls: toolCalls.length, contentLength: contentStr.length });
      if (ok) passed++; else failed++;
    } catch (e) {
      results.push({ file: sc.name, ok: false, error: String(e?.message || e) });
      failed++;
    }
  }

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
