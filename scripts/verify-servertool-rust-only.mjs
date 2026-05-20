#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SERVERTOOL_SRC = path.join(ROOT, 'sharedmodule/llmswitch-core/src/servertool');
const DESIGN_DOC = path.join(ROOT, 'docs/design/servertool-rust-only-architecture.md');
const BASELINE_FILE = path.join(ROOT, 'scripts/ci/servertool-rust-only-baseline.json');

const FORBIDDEN_PATTERNS = [
  { key: 'fallback', re: /fallback/gi },
  { key: 'degrade', re: /degrade/gi },
  { key: 'legacy_path', re: /legacy\s+path/gi },
];

const STRICT_ZERO_FILES = [
  'sharedmodule/llmswitch-core/src/servertool/engine.ts',
  'sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts',
  'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-response.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts',
  'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.ts',
  'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/clock-auto.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/continue-execution.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/web-search.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/web-search-auto-trigger.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/followup-message-blocks.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/followup-sanitize.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/clock-pure-blocks.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/web-search-pure-blocks.ts',
];

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
    }
  }
  out.sort();
  return out;
}

function collectCounts(files) {
  const counts = Object.fromEntries(FORBIDDEN_PATTERNS.map((p) => [p.key, 0]));
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const p of FORBIDDEN_PATTERNS) {
      p.re.lastIndex = 0;
      const m = content.match(p.re);
      counts[p.key] += m ? m.length : 0;
    }
  }
  return counts;
}

function main() {
  if (!fs.existsSync(DESIGN_DOC)) throw new Error(`missing design doc: ${path.relative(ROOT, DESIGN_DOC)}`);
  if (!fs.existsSync(BASELINE_FILE)) throw new Error(`missing baseline: ${path.relative(ROOT, BASELINE_FILE)}`);

  const doc = fs.readFileSync(DESIGN_DOC, 'utf8');
  if (!doc.includes('面向能力较弱模型的 apply_patch 执行计划（审计后新增）')) {
    throw new Error('design doc gate missing: 弱模型执行计划章节未找到');
  }
  if (!doc.includes('Patch 0')) {
    throw new Error('design doc gate missing: Patch 0..7 序列未找到');
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const baselineCounts = baseline?.forbiddenPatternCounts || {};

  const tsFiles = walkFiles(SERVERTOOL_SRC);
  if (tsFiles.length === 0) throw new Error('servertool source scan failed: no ts files found');

  const counts = collectCounts(tsFiles);

  const regressions = [];
  for (const [k, v] of Object.entries(counts)) {
    const base = Number(baselineCounts[k] ?? 0);
    if (v > base) regressions.push(`${k}: ${v} > baseline ${base}`);
  }

  const strictZeroViolations = [];
  for (const relPath of STRICT_ZERO_FILES) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const p of FORBIDDEN_PATTERNS) {
      p.re.lastIndex = 0;
      const m = content.match(p.re);
      const count = m ? m.length : 0;
      if (count > 0) {
        strictZeroViolations.push(`${relPath} -> ${p.key}: ${count}`);
      }
    }
  }

  if (regressions.length > 0 || strictZeroViolations.length > 0) {
    console.error('[verify:servertool-rust-only] regression detected against baseline');
    regressions.forEach((r) => console.error(`  - ${r}`));
    strictZeroViolations.forEach((r) => console.error(`  - strict-zero violation: ${r}`));
    process.exit(1);
  }

  console.log('[verify:servertool-rust-only] PASS');
  console.log(`- design doc gate: ok (${path.relative(ROOT, DESIGN_DOC)})`);
  console.log(`- baseline: ${path.relative(ROOT, BASELINE_FILE)}`);
  console.log(`- scanned servertool ts files: ${tsFiles.length}`);
  console.log(`- counts: ${JSON.stringify(counts)}`);
  console.log(`- strict-zero files checked: ${STRICT_ZERO_FILES.length}`);
}

main();
