import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const vrRoot = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine';
const tsContractFiles = [
  'sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts',
  'sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts',
];

const denyChecks = [
  {
    relRoot: vrRoot,
    extensions: new Set(['.rs']),
    patterns: [
      /should_fallback_direct_model_for_media/,
      /fallback:default/,
      /"fallback"\s*:/,
      /\bdid_fallback\b/,
    ],
  },
  {
    files: tsContractFiles,
    extensions: new Set(['.ts']),
    patterns: [
      /\bfallback\s*:\s*boolean\b/,
      /classification\.fallback\b/,
      /decision\.fallback\b/,
      /diagnostics\.fallback\b/,
      /fallback:default/,
    ],
  },
];

function listFiles(relRoot, extensions) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        stack.push(next);
        continue;
      }
      if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        out.push(next);
      }
    }
  }
  return out.sort();
}

const failures = [];
for (const check of denyChecks) {
  const files = check.files
    ? check.files.map((rel) => path.join(root, rel)).filter((file) => fs.existsSync(file))
    : listFiles(check.relRoot, check.extensions);
  for (const file of files) {
    const relFile = path.relative(root, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const pattern of check.patterns) {
        if (pattern.test(line)) {
          failures.push(`${relFile}:${index + 1}: ${line.trim()}`);
        }
      }
    });
  }
}

if (failures.length > 0) {
  console.error('[verify:vr-no-fallback-semantics] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) {
    console.error(`- ... ${failures.length - 120} more`);
  }
  process.exit(1);
}

console.log('[verify:vr-no-fallback-semantics] ok');
console.log(`- checked Rust root: ${vrRoot}`);
console.log(`- checked TS contract files: ${tsContractFiles.length}`);
