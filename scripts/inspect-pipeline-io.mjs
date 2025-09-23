#!/usr/bin/env node
// Inspect DebugCenter pipeline session files and summarize module IO

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const opts = Object.fromEntries(args.map((a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.replace(/^--/, '');
    const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
    return [k, v];
  }
  return [];
}).filter(Boolean));

const port = opts.port || process.env.ROUTECODEX_PORT || '5506';
const baseDirs = [
  path.join(os.homedir(), '.routecodex', 'logs'),
  path.join(process.cwd(), 'logs')
];
const limit = Number(opts.limit || 5);

async function findSessionFiles() {
  const results = [];
  for (const base of baseDirs) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const ent of entries) {
        const sub = path.join(base, ent.name);
        if (ent.isDirectory()) {
          const subEntries = await fs.readdir(sub, { withFileTypes: true });
          for (const se of subEntries) {
            const p = path.join(sub, se.name);
            if (se.isFile() && se.name.endsWith('.json')) {
              results.push(p);
            }
          }
        } else if (ent.isFile() && ent.name.endsWith('.json')) {
          results.push(sub);
        }
      }
    } catch {}
  }
  return results;
}

function summarizeOperation(op) {
  const inputKeys = op?.input ? Object.keys(op.input) : [];
  const outputKeys = op?.output ? Object.keys(op.output) : [];
  return {
    operationId: op.operationId,
    moduleId: op.moduleId,
    status: op.status,
    position: op.position,
    inputKeys,
    outputKeys
  };
}

async function main() {
  const files = await findSessionFiles();
  const matched = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, 'utf-8');
      const json = JSON.parse(raw);
      // Heuristics: must contain operations array
      if (Array.isArray(json.operations)) {
        matched.push({ file: f, sessionId: json.sessionId, pipelineId: json.pipelineId, startTime: json.startTime, json });
      }
    } catch {}
  }

  matched.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  const top = matched.slice(0, limit);
  if (top.length === 0) {
    console.log('No DebugCenter session files with module IO found under:', baseDirs.join(', '));
    process.exit(0);
  }

  for (const s of top) {
    console.log(`\n=== Session: ${s.sessionId} | Pipeline: ${s.pipelineId} | File: ${s.file}`);
    const ops = s.json.operations || [];
    for (const op of ops) {
      const sum = summarizeOperation(op);
      console.log(`- [${sum.status}] ${sum.position} ${sum.operationId} @ ${sum.moduleId} | in: ${sum.inputKeys.join(',')} | out: ${sum.outputKeys.join(',')}`);
    }
  }
}

main().catch((e) => {
  console.error('Failed to inspect pipeline IO:', e);
  process.exit(1);
});

