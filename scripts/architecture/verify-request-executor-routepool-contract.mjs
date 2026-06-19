import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TEST_ROOTS = [
  'tests/server/runtime/http-server',
  'tests/server/runtime',
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.isFile() && /\.(spec|test)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectBlocks(text) {
  const marker = 'resolveRequestExecutorPipelineAttempt({';
  const blocks = [];
  let start = 0;
  while (true) {
    const idx = text.indexOf(marker, start);
    if (idx === -1) break;
    let i = idx + marker.length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      i += 1;
    }
    blocks.push(text.slice(idx, i));
    start = i;
  }
  return blocks;
}

function collectTestCases(text) {
  const cases = [];
  const regex = /\bit\s*\(\s*(['"`])([\s\S]*?)\1\s*,/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    const next = regex.exec(text);
    const end = next ? next.index : text.length;
    if (next) {
      regex.lastIndex = next.index;
    }
    cases.push(text.slice(start, end));
    if (!next) {
      break;
    }
  }
  return cases;
}

const failures = [];

for (const rel of TEST_ROOTS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const text = fs.readFileSync(file, 'utf8');
    const cases = collectTestCases(text);
    for (const testCase of cases) {
      const blocks = collectBlocks(testCase);
      for (const block of blocks) {
      const hasExcluded = /excludedProviderKeys\s*:\s*new Set\s*\(/.test(block);
      const hasPool = /routingDecision\s*:\s*\{[\s\S]*?\bpool\s*:/.test(block);
      const hasRoutePool = /routingDecision\s*:\s*\{[\s\S]*?\broutePool\s*:/.test(block);
      const allowsMissingRoutePoolNegativeCase =
        /ERR_EXCLUDED_PROVIDER_RESELECTED_MISSING_ROUTE_POOL/.test(testCase)
        || /without explicit routePool/.test(testCase);
      if (hasExcluded && hasPool && !hasRoutePool && !allowsMissingRoutePoolNegativeCase) {
        const relFile = path.relative(ROOT, file);
        failures.push(
          `${relFile}: resolveRequestExecutorPipelineAttempt fixture uses excludedProviderKeys + routingDecision.pool without explicit routePool`
        );
      }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:request-executor-routepool-contract] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:request-executor-routepool-contract] ok');
