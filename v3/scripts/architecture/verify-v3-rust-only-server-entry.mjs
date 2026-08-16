import fs from 'node:fs';
import process from 'node:process';

const physicallyAbsent = [
  'src/index.ts',
  'src/cli.ts',
  'src/cli',
  'src/commands',
  'src/server',
  'src/providers',
];
const forbidden = [
  'resolveServerEntryPath',
  "node dist/index.js",
  "['dist/index.js']",
  "'dist/index.js'",
  'RouteCodexHttpServer',
  'dist/cli.js',
];
const failures = [];

for (const path of physicallyAbsent) {
  if (fs.existsSync(path)) failures.push(`${path}: legacy TS runtime entry must be physically absent`);
}

for (const file of ['package.json', 'scripts/run-bg.sh', 'scripts/run-fg-gtimeout.sh']) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const token of forbidden) {
    if (text.includes(token)) failures.push(`${file}: forbidden legacy server entry '${token}'`);
  }
}

if (failures.length) {
  console.error('[verify:v3-rust-only-server-entry] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-rust-only-server-entry] ok');
