import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetRoots = [
  'sharedmodule/llmswitch-core/src/conversion/hub/process',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
  'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage2_route_select.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs',
];
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);

const providerPatterns = [
  /\bdeepseek\b/i,
  /\bqwen\b/i,
  /\bwindsurf\b/i,
  /\bcascade\b/i,
];

const branchHints = [
  /\bif\b/,
  /\belse\s+if\b/,
  /\bswitch\b/,
  /\bcase\b/,
  /\bmatch\b/,
  /\bproviderFamily\b/,
  /\bproviderType\b/,
  /\bproviderName\b/,
  /\bmodelFamily\b/,
  /\bcontains\(/,
  /\bstarts_with\(/,
  /\bstartsWith\(/,
  /\beq_ignore_ascii_case\(/,
];

const allowlist = [
  {
    pathContains: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    textContains: 'provider-specific',
  },
  {
    pathContains: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    textContains: 'provider specific',
  },
  {
    pathContains: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    textContains: 'provider_name',
  },
  {
    pathContains: 'sharedmodule/llmswitch-core/src/router/virtual-router',
    textContains: 'provider_name',
  },
];

function listFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  if (fs.statSync(absRoot).isFile()) return [absRoot];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'dist' ||
          entry.name === 'node_modules' ||
          entry.name === 'coverage' ||
          entry.name === '__tests__' ||
          entry.name === 'tests'
        ) {
          continue;
        }
        stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

function isAllowed(relFile, line) {
  return allowlist.some((entry) => relFile.includes(entry.pathContains) && line.includes(entry.textContains));
}

function lineLooksLikeLeak(line) {
  const hasProvider = providerPatterns.some((pattern) => pattern.test(line));
  if (!hasProvider) return false;
  if (!branchHints.some((pattern) => pattern.test(line))) return false;
  if (line.includes('feature_id:')) return false;
  if (line.includes('protocol')) return false;
  if (line.includes('providerProtocol')) return false;
  if (line.includes('entryProtocol')) return false;
  if (line.includes('outboundProtocol')) return false;
  if (line.includes('provider_name')) return false;
  if (line.includes('provider-specific') || line.includes('provider specific')) return false;
  if (line.includes('TextToolProviderFamily')) return false;
  if (line.includes('metadata.get("deepseek")')) return false;
  return true;
}

const failures = [];
let checkedFiles = 0;

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    checkedFiles += 1;
    const relFile = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!lineLooksLikeLeak(line)) return;
      if (isAllowed(relFile, line)) return;
      failures.push(`${relFile}:${idx + 1}: ${line.trim()}`);
    });
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-provider-specific-leaks] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-provider-specific-leaks] ok');
console.log(`- checked files: ${checkedFiles}`);
console.log(`- target roots: ${targetRoots.length}`);
console.log(`- provider patterns: ${providerPatterns.length}`);
