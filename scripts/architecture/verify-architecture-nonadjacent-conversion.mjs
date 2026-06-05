import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetRoots = ['sharedmodule/llmswitch-core/src', 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src', 'src'];
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);
const failures = [];

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

function parseNodeNumber(name) {
  const m = name.match(/(HubReq|HubResp|VrRoute|ProviderReq|ProviderResp|ServerReq|ServerResp|ErrorErr)(\d{2})[A-Za-z]/);
  return m ? Number(m[2]) : null;
}

const tempNumberPatterns = [/\b03b\b/i, /\b03_1\b/, /\b03\.5\b/, /\b03p5\b/i];
const builderPattern = /\bbuild([A-Za-z0-9_]*?(HubReq|HubResp|VrRoute|ProviderReq|ProviderResp|ServerReq|ServerResp|ErrorErr)\d{2}[A-Za-z0-9_]*?)From([A-Za-z0-9_]+)\b/g;
const directShortcutPatterns = [
  /HubReqInbound02[^\n]{0,120}ProviderReqOutbound06/,
  /HubRespInbound02[^\n]{0,120}ServerRespOutbound05/,
  /ErrorErr02[^\n]{0,120}ErrorErr05/,
];

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, idx) => {
      for (const pat of tempNumberPatterns) {
        if (pat.test(line)) {
          failures.push(`${relFile}:${idx + 1}: temporary node numbering forbidden -> ${line.trim()}`);
        }
      }
    });

    for (const match of source.matchAll(builderPattern)) {
      const full = match[0];
      const targetName = match[1];
      const fromName = match[3];
      const targetNumber = parseNodeNumber(targetName);
      const fromNumber = parseNodeNumber(fromName);
      if (targetNumber === null || fromNumber === null) continue;
      if (Math.abs(targetNumber - fromNumber) > 1) {
        failures.push(`${relFile}: non-adjacent builder pattern -> ${full}`);
      }
    }

    for (const pat of directShortcutPatterns) {
      if (pat.test(source)) {
        failures.push(`${relFile}: direct shortcut pattern matched ${pat}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-nonadjacent-conversion] failed');
  failures.slice(0, 120).forEach((f) => console.error(`- ${f}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-nonadjacent-conversion] ok');
console.log(`- checked roots: ${targetRoots.join(', ')}`);
