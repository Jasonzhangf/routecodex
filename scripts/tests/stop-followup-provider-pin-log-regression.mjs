#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const logPath = path.resolve(process.env.RCC_SERVER_LOG || path.join(process.env.HOME || '', '.rcc/logs/server-5520.log'));
if (!fs.existsSync(logPath)) {
  console.error(`[stop-followup-provider-pin-regression] log not found: ${logPath}`);
  process.exit(2);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split(/\r?\n/);

let violations = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.includes('[hub.run.input]')) continue;
  if (!line.includes(':stop_followup')) continue;
  if (!line.includes('"forcedProviderKey":"mini27.key1.MiniMax-M2.7"')) continue;

  const window = lines.slice(i, Math.min(lines.length, i + 30)).join('\n');
  const hasWrongRoute = /search\/forced -> mini27\.key1\.minimax\.minimax/i.test(window);
  if (hasWrongRoute) {
    violations += 1;
  }
}

if (violations > 0) {
  console.error(`[stop-followup-provider-pin-regression] FAIL violations=${violations}`);
  process.exit(1);
}

console.log('[stop-followup-provider-pin-regression] PASS no provider pin mismatch detected');
