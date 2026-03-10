#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const packageJsonPath = path.join(projectRoot, 'package.json');

function parseArgs(argv) {
  const out = { filter: '', from: '', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--filter' && argv[i + 1]) {
      out.filter = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (arg === '--from' && argv[i + 1]) {
      out.from = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
  }
  return out;
}

function main() {
  const { filter, from, dryRun } = parseArgs(process.argv);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const allScripts = Object.keys(pkg.scripts || {});
  const selected = allScripts
    .filter((name) => name.startsWith('verify:shadow-gate:'))
    .filter((name) => name !== 'verify:shadow-gate:all')
    .filter((name) => (filter ? name.includes(filter) : true))
    .sort();

  const resumed = from ? selected.filter((name) => name >= from) : selected;

  if (!resumed.length) {
    console.error(`[shadow-gate-all] no verify scripts matched (filter="${filter}")`);
    process.exit(1);
  }

  console.log(`[shadow-gate-all] selected ${resumed.length} script(s)`);
  if (dryRun) {
    for (const name of resumed) {
      console.log(`[shadow-gate-all] dry-run: npm run ${name}`);
    }
    return;
  }

  for (const name of resumed) {
    console.log(`[shadow-gate-all] run: npm run ${name}`);
    const run = spawnSync('npm', ['run', name], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env
    });
    if ((run.status ?? 1) !== 0) {
      console.error(`[shadow-gate-all] failed: ${name}`);
      process.exit(run.status ?? 1);
    }
  }

  console.log('[shadow-gate-all] PASS');
}

main();
