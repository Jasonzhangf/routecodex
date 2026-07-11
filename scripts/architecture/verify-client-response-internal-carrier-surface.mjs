import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const responseLayerFiles = [
  'src/server/handlers/handler-response-common.ts',
  'src/server/handlers/handler-response-sse.ts',
  'src/server/handlers/handler-response-utils.ts',
  'src/modules/llmswitch/bridge/responses-response-bridge.ts',
];

const requiredAnchors = [
  {
    file: 'src/server/handlers/handler-response-common.ts',
    snippet: 'assertClientResponseHasNoInternalCarriers',
    reason: 'JSON/SSE client response projection must keep a dedicated fail-fast carrier guard.',
  },
];

const rules = [
  {
    id: 'routecodex_prefix',
    regex: /__routecodex[A-Za-z0-9_]*/g,
    allowedFiles: new Set([
      'src/server/handlers/handler-response-common.ts',
    ]),
    reason: 'client-visible response/SSE layer must not grow ad hoc __routecodex* payload semantics outside the two fail-fast guard owners.',
  },
  {
    id: 'rt_prefix',
    regex: /\b__rt\b/g,
    allowedFiles: new Set([
      'src/server/handlers/handler-response-common.ts',
    ]),
    reason: 'client-visible response/SSE layer must not inspect __rt outside the dedicated guard owners.',
  },
  {
    id: 'legacy_sse_prefix',
    regex: /__sse_[A-Za-z0-9_]*/g,
    allowedFiles: new Set(),
    reason: 'legacy __sse_* wrapper semantics must not reappear anywhere in the client-visible response/SSE layer.',
  },
  {
    id: 'responses_metadata_event',
    regex: /\bresponse\.metadata\b/g,
    allowedFiles: new Set(),
    reason: 'response.metadata SSE protocol semantics must not be owned by server response bridges.',
  },
];

const failures = [];
const counts = new Map(rules.map((rule) => [rule.id, 0]));

for (const relFile of responseLayerFiles) {
  const absFile = path.join(repoRoot, relFile);
  if (!fs.existsSync(absFile)) {
    failures.push(`missing response-layer file: ${relFile}`);
    continue;
  }
  const text = fs.readFileSync(absFile, 'utf8');
  const lines = text.split(/\r?\n/);

  for (const rule of rules) {
    const matches = [...text.matchAll(rule.regex)];
    if (matches.length === 0) {
      continue;
    }
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + matches.length);
    if (rule.allowedFiles.has(relFile)) {
      continue;
    }
    lines.forEach((line, index) => {
      const lineMatches = [...line.matchAll(rule.regex)];
      if (lineMatches.length === 0) {
        return;
      }
      failures.push(
        `${relFile}:${index + 1} [${rule.id}] ${lineMatches.map((match) => match[0]).join(', ')} :: ${rule.reason}`
      );
    });
  }
}

for (const anchor of requiredAnchors) {
  const absFile = path.join(repoRoot, anchor.file);
  if (!fs.existsSync(absFile)) {
    failures.push(`missing required guard owner file: ${anchor.file}`);
    continue;
  }
  const text = fs.readFileSync(absFile, 'utf8');
  if (!text.includes(anchor.snippet)) {
    failures.push(`${anchor.file} missing required guard anchor "${anchor.snippet}" :: ${anchor.reason}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:client-response-internal-carrier-surface] violations found');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:client-response-internal-carrier-surface] ok');
for (const rule of rules) {
  console.log(`- ${rule.id}: ${counts.get(rule.id) ?? 0} matches across ${responseLayerFiles.length} response-layer files`);
}
