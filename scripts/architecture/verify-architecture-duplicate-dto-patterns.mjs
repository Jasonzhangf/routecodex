import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetRoots = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
  'sharedmodule/llmswitch-core/src',
  'src',
];
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);
const nodeNamePattern =
  /(HubReq[A-Za-z0-9]+|HubResp[A-Za-z0-9]+|VrRoute[0-9]{2}[A-Za-z0-9]+|ErrorErr[0-9]{2}[A-Za-z0-9]+)/g;

function listFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage') continue;
        stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const definitions = new Map();

function record(name, kind, file, line) {
  const arr = definitions.get(name) || [];
  arr.push({ kind, file, line });
  definitions.set(name, arr);
}

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const rustStruct = line.match(/\bpub(?:\(crate\))?\s+struct\s+([A-Za-z0-9_]+)/);
      if (rustStruct && nodeNamePattern.test(rustStruct[1])) {
        record(rustStruct[1], 'rust-struct', relFile, index + 1);
      }
      const rustEnum = line.match(/\bpub(?:\(crate\))?\s+enum\s+([A-Za-z0-9_]+)/);
      if (rustEnum && nodeNamePattern.test(rustEnum[1])) {
        record(rustEnum[1], 'rust-enum', relFile, index + 1);
      }
      const tsInterface = line.match(/\bexport\s+interface\s+([A-Za-z0-9_]+)/);
      if (tsInterface && nodeNamePattern.test(tsInterface[1])) {
        record(tsInterface[1], 'ts-interface', relFile, index + 1);
      }
      const tsClass = line.match(/\bexport\s+class\s+([A-Za-z0-9_]+)/);
      if (tsClass && nodeNamePattern.test(tsClass[1])) {
        record(tsClass[1], 'ts-class', relFile, index + 1);
      }
      const tsType = line.match(/\bexport\s+type\s+([A-Za-z0-9_]+)\s*=/);
      if (tsType && nodeNamePattern.test(tsType[1])) {
        record(tsType[1], 'ts-type', relFile, index + 1);
      }
    });
  }
}

const failures = [];

for (const [name, entries] of definitions.entries()) {
  const rustDefs = entries.filter((entry) => entry.kind === 'rust-struct' || entry.kind === 'rust-enum');
  const tsShapeDefs = entries.filter((entry) => entry.kind === 'ts-interface' || entry.kind === 'ts-class');
  const tsAliases = entries.filter((entry) => entry.kind === 'ts-type');

  const detail = entries.map((entry) => `${entry.file}:${entry.line}(${entry.kind})`).join(', ');

  if (rustDefs.length > 1) {
    failures.push(`${name}: multiple Rust defining declarations -> ${detail}`);
    continue;
  }
  if (tsShapeDefs.length > 1) {
    failures.push(`${name}: multiple TS shape declarations -> ${detail}`);
    continue;
  }
  if (rustDefs.length >= 1 && (tsShapeDefs.length >= 1 || tsAliases.length >= 1)) {
    failures.push(`${name}: Rust truth mirrored by TS declarations -> ${detail}`);
    continue;
  }
  if (tsShapeDefs.length === 1 && tsAliases.length >= 1) {
    failures.push(`${name}: TS shape plus alias mirrors -> ${detail}`);
    continue;
  }
  if (tsAliases.length > 1) {
    failures.push(`${name}: alias-like duplicate definitions -> ${detail}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-duplicate-dto-patterns] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:architecture-duplicate-dto-patterns] ok');
console.log(`- checked node definitions: ${definitions.size}`);
