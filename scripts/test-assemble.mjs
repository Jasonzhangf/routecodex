#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function findLatestMergedConfig() {
  const dir = path.resolve(process.cwd(), 'config');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter(f => /^merged-config\..*\.json$/.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  if (!files.length) throw new Error('No merged-config.*.json found');
  return path.join(dir, files[0].name);
}

async function main() {
  const mergedPath = process.argv[2] || findLatestMergedConfig();
  const { PipelineAssembler } = await import('../dist/modules/pipeline/config/pipeline-assembler.js');
  const res = await PipelineAssembler.assembleFromFile(mergedPath);
  const keys = Object.keys(res.routePools || {});
  console.log(JSON.stringify({ mergedPath, routePoolCount: keys.length, routePools: keys.slice(0, 10) }, null, 2));
}

main().catch(e => { console.error('assemble failed:', e?.stack || String(e)); process.exit(1); });

