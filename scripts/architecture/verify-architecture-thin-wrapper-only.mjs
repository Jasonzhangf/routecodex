import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetRoots = [
  'sharedmodule/llmswitch-core/src/conversion/hub/process',
  'sharedmodule/llmswitch-core/src/native/router-hotpath',
];
const exts = new Set(['.ts']);

const allowedFiles = new Set([
  'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search.ts',
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts',
]);

const dangerousPatterns = [
  /\b(messages|tool_calls|toolCalls)\s*\.\s*(push|splice|pop|shift|unshift)\s*\(/,
  /\b(messages|tool_calls|toolCalls)\s*\[[^\]]+\]\s*=/,
  /\b[A-Za-z0-9_.[\]'"]+\.(messages|tool_calls|toolCalls|content|payload)\s*=\s*(?![=])/,
  /\bdelete\s+[A-Za-z0-9_.\[\]'"]*(messages|tool_calls|toolCalls|content|payload)\b/,
];

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
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'tests') {
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

function isRiskyLine(line) {
  return dangerousPatterns.some((pattern) => pattern.test(line));
}

const failures = [];
let checkedFiles = 0;

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    if (allowedFiles.has(relFile)) continue;
    checkedFiles += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!isRiskyLine(line)) return;
      failures.push(`${relFile}:${idx + 1}: ${line.trim()}`);
    });
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-thin-wrapper-only] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-thin-wrapper-only] ok');
console.log(`- checked files: ${checkedFiles}`);
console.log(`- target roots: ${targetRoots.length}`);
console.log(`- allowlisted files: ${allowedFiles.size}`);
