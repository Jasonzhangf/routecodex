import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetRoots = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types',
  'sharedmodule/llmswitch-core/src/router/virtual-router',
  'src/providers/core/runtime',
  'src/server/runtime/http-server/executor',
  'src/server/utils',
];
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);
const failures = [];

const exactAllowlist = new Set([
  'build_hub_req_inbound_02_from_payload',
  'build_meta_req_02_runtime_carrier',
  'build_meta_route_03_from_metadata',
  'build_error_err_03_runtime_classified',
  'classify_error_err_03_runtime_from_error_err_02_host',
  'apply_error_err_04_router_policy_from_error_err_03_runtime',
  'consume_error_err_05_execution_decision_from_error_err_04_router_policy',
  'project_error_err_06_client_from_error_err_05_execution_decision',
]);

const declarationPattern =
  /\b(?:pub(?:\(crate\))?\s+fn|export\s+function|function)\s+([a-z][a-z0-9_]*)\s*\(/g;
const adjacentPattern =
  /^(build|parse|project)_((?:hub|vr|provider|server|error|meta)_[a-z0-9_]+)_(\d{2})(?:_[a-z0-9]+)?_from_((?:hub|vr|provider|server|error|meta)_[a-z0-9_]+)_(\d{2})(?:_[a-z0-9]+)?$/;
const nodeCarrierPattern =
  /^(build|parse|project|classify|apply|consume)_(hub|vr|provider|server|error|meta)_[a-z0-9]+_(\d{2})_.+$/;
const forbiddenLegacyPattern = /_(req_process|resp_process)_/;
const targetVerbPrefixes = ['build_', 'parse_', 'project_', 'classify_', 'apply_', 'consume_'];

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
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === 'target') continue;
        stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(declarationPattern)) {
      const name = match[1];
      if (!targetVerbPrefixes.some((prefix) => name.startsWith(prefix))) {
        continue;
      }

      if (forbiddenLegacyPattern.test(name)) {
        failures.push(`${relFile}: legacy req_process/resp_process builder naming forbidden -> ${name}`);
        continue;
      }

      if (exactAllowlist.has(name)) {
        continue;
      }

      const nodeCarrierMatch = name.match(nodeCarrierPattern);
      if (!nodeCarrierMatch) {
        continue;
      }

      const adjacentMatch = name.match(adjacentPattern);
      if (adjacentMatch) {
        const targetNumber = Number(adjacentMatch[3]);
        const sourceNumber = Number(adjacentMatch[5]);
        if (Math.abs(targetNumber - sourceNumber) !== 1) {
          failures.push(`${relFile}: non-adjacent builder naming forbidden -> ${name}`);
        }
        continue;
      }

      failures.push(
        `${relFile}: architecture builder/parser/projector must encode explicit adjacent source -> ${name}`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-adjacent-builder-naming] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) {
    console.error(`- ... ${failures.length - 120} more`);
  }
  process.exit(1);
}

console.log('[verify:architecture-adjacent-builder-naming] ok');
console.log(`- checked roots: ${targetRoots.join(', ')}`);
console.log(`- allowlisted special entrypoints: ${exactAllowlist.size}`);
