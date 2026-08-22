#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveLogPath() {
  const arg = process.argv[2]?.trim();
  if (arg) return path.resolve(arg);
  return path.join(os.homedir(), '.rcc', 'logs', 'server-5520.log');
}

const logPath = resolveLogPath();
if (!fs.existsSync(logPath)) {
  console.error(`[followup-shape-check] log not found: ${logPath}`);
  process.exit(2);
}

const text = fs.readFileSync(logPath, 'utf8');
const lines = text.split(/\r?\n/);

const violations = [];
for (const line of lines) {
  if (!line.includes('[hub.run.input]')) continue;
  const idx = line.indexOf('{');
  if (idx < 0) continue;
  let payload;
  try {
    payload = JSON.parse(line.slice(idx));
  } catch {
    continue;
  }
  const requestId = String(payload.requestId || '');
  const entryEndpoint = String(payload.entryEndpoint || '');
  const serverToolFollowup = payload.serverToolFollowup === true || requestId.includes(':stop_followup');
  if (!serverToolFollowup) continue;

  const isResponses = entryEndpoint.includes('/v1/responses');
  const hasInput = payload.bodyHasInput === true;
  const hasMessages = payload.bodyHasMessages === true;

  if (isResponses && !hasInput && hasMessages) {
    violations.push({
      requestId,
      entryEndpoint,
      forcedProviderKey: payload.forcedProviderKey,
      routeHint: payload.routeHint,
      routeName: payload.routeName,
      bodyModel: payload.bodyModel,
      rule: 'responses_followup_must_use_input_shape'
    });
  }
}

if (violations.length === 0) {
  console.log(`[followup-shape-check] OK: no illegal responses followup shape found. log=${logPath}`);
  process.exit(0);
}

console.error(`[followup-shape-check] FAIL: found ${violations.length} illegal followup shapes. log=${logPath}`);
for (const v of violations.slice(0, 50)) {
  console.error(JSON.stringify(v));
}
if (violations.length > 50) {
  console.error(`[followup-shape-check] ... truncated ${violations.length - 50} more`);
}
process.exit(1);
