import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const scanRoots = ['src', 'sharedmodule/llmswitch-core/src', 'tests', 'v3/crates'];
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);

const exactStages = new Set([
  'client-request',
  'client-response',
  'client-response.error',
  'provider-request',
  'provider-request-contract',
  'provider-request.retry',
  'provider-response',
  'provider-response-contract',
  'provider-response.retry',
  'provider-error',
  'provider-preprocess-debug',
  'provider-body-debug',
  'repair-feedback',
]);

const prefixStages = [
  'chat_process.req.',
  'chat_process.resp.',
  'hub_followup.',
  'servertool.',
];

const candidatePatterns = [
  /shouldCaptureSnapshotStage\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  /should_capture_snapshot_stage\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  /\brecord\(\s*['"`]([^'"`]+)['"`]\s*,/g,
  /\bphase:\s*['"`]([^'"`]+)['"`]/g,
];

const fileInterestPattern =
  /shouldCaptureSnapshotStage\(|should_capture_snapshot_stage\(|writeProviderSnapshot\(|writeServerSnapshot\(|\brecord\(\s*['"`](?:chat_process|hub_followup|servertool)|\bphase:\s*['"`](?:client-|provider-|repair-feedback)/;

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function listFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) {
    return [];
  }
  const out = [];
  const stack = [absRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage' || entry.name === 'target') {
          continue;
        }
        stack.push(next);
        continue;
      }
      if (!exts.has(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) {
        continue;
      }
      out.push(next);
    }
  }
  return out;
}

function isSnapshotStageCandidate(stage) {
  return (
    exactStages.has(stage)
    || prefixStages.some((prefix) => stage.startsWith(prefix))
    || stage.startsWith('client-')
    || stage.startsWith('provider-')
    || stage === 'repair-feedback'
  );
}

function isAllowedSnapshotStage(stage) {
  return exactStages.has(stage) || prefixStages.some((prefix) => stage.startsWith(prefix));
}

const discovered = new Map();
const targetFiles = [];

for (const scanRoot of scanRoots) {
  for (const absPath of listFiles(scanRoot)) {
    const relPath = path.relative(root, absPath);
    const source = read(relPath);
    if (!fileInterestPattern.test(source)) {
      continue;
    }
    targetFiles.push(relPath);
    for (const pattern of candidatePatterns) {
      for (const match of source.matchAll(pattern)) {
        const stage = String(match[1] || '').trim();
        if (!stage || !isSnapshotStageCandidate(stage)) {
          continue;
        }
        if (!discovered.has(stage)) {
          discovered.set(stage, new Set());
        }
        discovered.get(stage).add(relPath);
        if (!isAllowedSnapshotStage(stage)) {
          failures.push(`${relPath}: snapshot stage must use approved owner family -> ${stage}`);
        }
      }
    }
  }
}

const contractDoc = read('docs/architecture/snapshot-stage-contract.md');
for (const token of [
  'diagnostic correlation only',
  'L8 observability/debug',
  'L5 Metadata Center',
  'must never restore or own StoplessCenter control truth',
]) {
  if (!contractDoc.includes(token)) {
    failures.push(`snapshot contract doc missing StoplessCenter observability owner boundary: ${token}`);
  }
}
for (const exact of exactStages) {
  if (!contractDoc.includes(exact)) {
    failures.push(`snapshot contract doc missing exact stage token: ${exact}`);
  }
}
for (const prefix of prefixStages) {
  if (!contractDoc.includes(prefix)) {
    failures.push(`snapshot contract doc missing owner family token: ${prefix}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-snapshot-stage-owners] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:architecture-snapshot-stage-owners] ok');
console.log(`- checked files: ${targetFiles.length}`);
console.log(`- discovered stages: ${discovered.size}`);
