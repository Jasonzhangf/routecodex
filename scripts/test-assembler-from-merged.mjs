#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { PipelineAssembler } from '../dist/modules/pipeline/config/pipeline-assembler.js';

function parseArgs() {
  const argv = process.argv.slice(2);
  const idx = argv.findIndex(a => a === '--file' || a === '-f');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  throw new Error('Usage: node scripts/test-assembler-from-merged.mjs --file <merged-config.json>');
}

async function main() {
  const file = parseArgs();
  const abs = path.resolve(file.replace(/^~/, process.env.HOME || ''));
  const text = fs.readFileSync(abs, 'utf8');
  const merged = JSON.parse(text);

  const { manager, routePools, routeMeta } = await PipelineAssembler.assemble(merged);
  const ids = manager.getAllPipelines ? manager.getAllPipelines().map(p => p.id) : (manager.config?.pipelines || []).map(p => p.id);
  const routesSummary = Object.fromEntries(Object.entries(routePools).map(([k,v]) => [k, (v || []).length]));
  console.log(JSON.stringify({ ok: true, pipelines: ids.length, first: ids.slice(0, 8), routes: routesSummary, metaCount: Object.keys(routeMeta || {}).length }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('assemble_error', e?.message || e); process.exit(2); });

