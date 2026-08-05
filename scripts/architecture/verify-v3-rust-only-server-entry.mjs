import fs from 'node:fs';
import process from 'node:process';

const productionFiles = [
  'src/cli.ts',
  'src/cli/commands/start.ts',
  'src/cli/commands/launcher-kernel.ts',
  'package.json',
  'scripts/run-bg.sh',
  'scripts/run-fg-gtimeout.sh',
];
const forbidden = [
  'resolveServerEntryPath',
  "node dist/index.js",
  "['dist/index.js']",
  "'dist/index.js'",
  'RouteCodexHttpServer',
];
const failures = [];

if (fs.existsSync('src/index.ts')) failures.push('src/index.ts: legacy TS HTTP server entry must be physically absent');

for (const file of productionFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const token of forbidden) {
    if (text.includes(token)) failures.push(`${file}: forbidden legacy server entry '${token}'`);
  }
}

for (const file of ['src/cli.ts', 'src/cli/commands/start.ts', 'src/cli/commands/launcher-kernel.ts']) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('serverBin || nodeBin')) failures.push(`${file}: server spawn may fall back to nodeBin`);
  if (!text.includes('server start') && file !== 'src/cli.ts') failures.push(`${file}: Rust server command is not declared`);
}

if (failures.length) {
  console.error('[verify:v3-rust-only-server-entry] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-rust-only-server-entry] ok');
