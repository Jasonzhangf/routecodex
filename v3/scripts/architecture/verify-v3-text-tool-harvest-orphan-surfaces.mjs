#!/usr/bin/env node
/**
 * feature_id: hub.resp_chatprocess.text_tool_harvest_complete
 * Anti-orphan gate: V2 harvest NAPI / modules must not re-enter production
 * TS/bridge/src paths. V3 resp_chatprocess strict harvest is the single owner.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scanRoots = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'tests',
].map((rel) => path.join(root, rel));

const forbiddenSymbols = [
  'compat_harvest_tool_calls_from_text',
  'harvest_tool_calls_from_text_json',
  'extract_streaming_tool_calls_json',
  'create_streaming_tool_extractor_state_json',
  'reset_streaming_tool_extractor_state_json',
  'feed_streaming_tool_extractor_json',
  'harvest_tools_json',
  'streaming_tool_extractor',
  'tool_harvester',
  'run_resp_inbound_stage3_compat',
  'run_resp_inbound_stage3_compat_json',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(abs);
  }
  return out;
}

const hits = [];
for (const rootDir of scanRoots) {
  for (const file of walk(rootDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const symbol of forbiddenSymbols) {
      if (text.includes(symbol)) {
        hits.push({ file: path.relative(root, file), symbol });
      }
    }
  }
}

if (hits.length > 0) {
  console.error('[verify:v3-text-tool-harvest-orphan-surfaces] FAIL');
  for (const hit of hits) {
    console.error(`- ${hit.file}: forbidden orphan surface ${hit.symbol}`);
  }
  process.exit(1);
}


const forbiddenRustPaths = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/tool_harvester.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/tool_harvester',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/streaming_tool_extractor.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/streaming_tool_extractor',
];
for (const rel of forbiddenRustPaths) {
  if (fs.existsSync(path.join(root, rel))) {
    console.error(`[verify:v3-text-tool-harvest-orphan-surfaces] forbidden orphan Rust surface exists: ${rel}`);
    process.exit(1);
  }
}

const libRs = path.join(root, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs');
const libText = fs.readFileSync(libRs, 'utf8');
for (const forbiddenMod of ['mod tool_harvester;', 'mod streaming_tool_extractor;']) {
  if (libText.includes(forbiddenMod)) {
    console.error(`[verify:v3-text-tool-harvest-orphan-surfaces] forbidden Rust module declaration: ${forbiddenMod}`);
    process.exit(1);
  }
}

// Positive anchor: V3 owner modules must exist.
const requiredOwners = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/orchestrator.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/text_harvest_strict.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_call_governance.rs',
];
for (const rel of requiredOwners) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`[verify:v3-text-tool-harvest-orphan-surfaces] missing owner ${rel}`);
    process.exit(1);
  }
}

console.log('[verify:v3-text-tool-harvest-orphan-surfaces] ok');
console.log(`- scanned roots: ${scanRoots.map((p) => path.relative(root, p)).join(', ')}`);
console.log(`- forbidden symbols checked: ${forbiddenSymbols.length}`);
console.log(`- forbidden Rust surfaces checked: ${forbiddenRustPaths.length}`);
