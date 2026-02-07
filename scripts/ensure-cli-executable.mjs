#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const cliPath = path.join(process.cwd(), 'dist', 'cli.js');

if (process.platform === 'win32') {
  process.exit(0);
}

if (!fs.existsSync(cliPath)) {
  process.exit(0);
}

try {
  const stat = fs.statSync(cliPath);
  const nextMode = stat.mode | 0o111;
  fs.chmodSync(cliPath, nextMode);
} catch {
  process.exit(0);
}
