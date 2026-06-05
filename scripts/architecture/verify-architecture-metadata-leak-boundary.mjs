import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetFiles = [
  'src/providers/core/runtime',
  'src/server/handlers',
  'sharedmodule/llmswitch-core/src/conversion/responses',
  'sharedmodule/llmswitch-core/src/conversion/hub/response',
];

const exts = new Set(['.ts', '.js']);

const dangerousPatterns = [
  /\b(body|payload|response|output|frame)\.metadata\s*=\s*[^=]/,
  /\b(body|payload|response|output|frame)\.__rt\s*=\s*[^=]/,
  /\b(body|payload|response|output|frame)\.(metaCarrier|errorCarrier|snapshot|debug|runtimeMetadata)\s*=\s*[^=]/,
  /\b(body|payload|response|output|frame)\s*\[\s*['"]metadata['"]\s*\]\s*=\s*[^=]/,
  /\b(body|payload|response|output|frame)\s*\[\s*['"]__rt['"]\s*\]\s*=\s*[^=]/,
  /\b(body|payload|response|output|frame)\s*\[\s*['"](metaCarrier|errorCarrier|snapshot|debug|runtimeMetadata)['"]\s*\]\s*=\s*[^=]/,
];

const allowlist = [
  {
    pathContains: 'src/providers/core/runtime/provider-request-preprocessor.ts',
    textContains: 'runtimeMetadata.metadata = {}',
  },
  {
    pathContains: 'src/providers/core/runtime/http-transport-provider.ts',
    textContains: 'runtimeMetadata.metadata = {}',
  },
  {
    pathContains: 'src/error-handling/route-error-hub.ts',
    textContains: 'metadata: payload.metadata',
  },
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

function isAllowed(relFile, line) {
  return allowlist.some((entry) => relFile.includes(entry.pathContains) && line.includes(entry.textContains));
}

const failures = [];
let checkedFiles = 0;

for (const relRoot of targetFiles) {
  for (const file of listFiles(relRoot)) {
    checkedFiles += 1;
    const relFile = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!dangerousPatterns.some((pattern) => pattern.test(line))) return;
      if (isAllowed(relFile, line)) return;
      failures.push(`${relFile}:${idx + 1}: ${line.trim()}`);
    });
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-metadata-leak-boundary] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-metadata-leak-boundary] ok');
console.log(`- checked files: ${checkedFiles}`);
console.log(`- target roots: ${targetFiles.length}`);
