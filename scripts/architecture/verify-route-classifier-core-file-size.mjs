#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceRoot = process.env.ROUTECODEX_ROUTE_CLASSIFIER_CORE_ROOT
  ? path.resolve(process.env.ROUTECODEX_ROUTE_CLASSIFIER_CORE_ROOT)
  : path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/src'
    );
const limit = 500;

function rustFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return rustFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.rs') ? [absolute] : [];
  });
}

const files = rustFiles(sourceRoot);
if (files.length === 0) {
  console.error(`[verify:route-classifier-core-file-size] no Rust source files under ${sourceRoot}`);
  process.exit(1);
}

const violations = files
  .map((file) => ({
    file,
    lines: fs.readFileSync(file, 'utf8').split(/\r?\n/).length
  }))
  .filter(({ lines }) => lines > limit);

if (violations.length > 0) {
  console.error(`[verify:route-classifier-core-file-size] files exceed ${limit} lines`);
  for (const { file, lines } of violations) {
    console.error(`- ${path.relative(repoRoot, file)}: ${lines}`);
  }
  process.exit(1);
}

console.log(
  `[verify:route-classifier-core-file-size] ok files=${files.length} limit=${limit}`
);
