#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') { out.name = argv[++i]; continue; }
    if (a === '--bin') { out.bin = argv[++i]; continue; }
    if (a === '--tag') { out.tag = argv[++i]; continue; }
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.name || !args.bin) {
  console.error('Usage: node scripts/pack-mode.mjs --name <packageName> --bin <binName>');
  process.exit(1);
}

const pkgPath = path.join(process.cwd(), 'package.json');
const backupPath = pkgPath + '.bak.pack';

const original = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));

try {
  const mutated = { ...original };
  mutated.name = args.name;
  mutated.bin = { [args.bin]: 'dist/cli.js' };
  // Ensure description mentions mode
  const suffix = args.name === 'rcc' ? ' (release)' : ' (dev)';
  mutated.description = String(original.description || 'RouteCodex').replace(/\s*\((dev|release)\)$/, '') + suffix;
  fs.writeFileSync(pkgPath, JSON.stringify(mutated, null, 2));

  // pack
  const r = spawnSync('npm', ['pack'], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error('npm pack failed');
  }
} finally {
  // restore
  fs.writeFileSync(pkgPath, fs.readFileSync(backupPath, 'utf-8'));
  fs.unlinkSync(backupPath);
}

