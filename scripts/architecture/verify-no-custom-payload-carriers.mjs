import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const scanRoots = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
];

const forbidden = [
  {
    pattern: '__sse_responses',
    reason: 'SSE streams must use typed runtime side-channel fields, not response payload wrapper keys.',
  },
  {
    pattern: '__sse_stream',
    reason: 'Legacy SSE stream markers must not appear as response payload wrapper keys.',
  },
  {
    pattern: '__routecodexDirectPassthrough',
    reason: 'Direct/relay owner must use MetadataCenter or typed result side-channel, not metadata payload keys.',
  },
  {
    pattern: '__routecodex_finish_reason',
    reason: 'Finish reason must come from protocol semantics/runtime side-channel, not custom payload keys.',
  },
  {
    pattern: '__routecodex_stream_contract_probe_body',
    reason: 'Stream contract probes must not be carried inside response payload wrappers.',
  },
  {
    pattern: '__routecodex_reasoning_stop_finalized',
    reason: 'Stopless/servertool state must stay in chat process/runtime metadata, not response payload keys.',
  },
];

const allowedExtensions = new Set([
  '.c',
  '.h',
  '.js',
  '.jsx',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'target' || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];

for (const scanRoot of scanRoots) {
  for (const file of walk(path.join(repoRoot, scanRoot))) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of forbidden) {
        if (line.includes(rule.pattern)) {
          violations.push({
            file: rel,
            line: index + 1,
            pattern: rule.pattern,
            reason: rule.reason,
          });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error('[verify-no-custom-payload-carriers] forbidden custom payload carrier fields found:');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.pattern}`);
    console.error(`  ${violation.reason}`);
  }
  process.exit(1);
}

console.log('[verify-no-custom-payload-carriers] ok');
