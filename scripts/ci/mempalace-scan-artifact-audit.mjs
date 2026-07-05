import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function fail(message) {
  console.error(`[mempalace-scan-artifact-audit] ${message}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || '');
}

const mempalacePath = run('command', ['-v', 'mempalace'], {
  shell: true,
}).trim();

if (!mempalacePath) {
  fail('mempalace binary not found on PATH');
}

const launcher = fs.readFileSync(mempalacePath, 'utf8').split(/\r?\n/, 1)[0] ?? '';
const pythonPath = launcher.startsWith('#!') ? launcher.slice(2).trim() : '';
if (!pythonPath) {
  fail(`cannot read python launcher from ${mempalacePath}`);
}

const pythonProgram = String.raw`
import json
import re
from pathlib import Path
from mempalace.miner import scan_project

root = Path.cwd()
files = [Path(p).relative_to(root).as_posix() for p in scan_project(str(root), respect_gitignore=True)]
patterns = {
    "dist": re.compile(r"(^|/)dist/"),
    "node_modules": re.compile(r"(^|/)node_modules/"),
    "target": re.compile(r"(^|/)target/"),
    "coverage": re.compile(r"(^|/)coverage/"),
    "build": re.compile(r"(^|/)build/"),
    ".next": re.compile(r"(^|/)\.next/"),
    ".turbo": re.compile(r"(^|/)\.turbo/"),
    ".local-index": re.compile(r"(^|/)\.local-index/"),
    ".mempalace": re.compile(r"(^|/)\.mempalace/"),
}
hits = {name: [path for path in files if pattern.search(path)] for name, pattern in patterns.items()}
print(json.dumps({"scannedFiles": len(files), "hits": hits}, ensure_ascii=False))
`;

const raw = run(pythonPath, ['-c', pythonProgram]);
let audit;
try {
  audit = JSON.parse(raw);
} catch (error) {
  fail(`invalid JSON from mempalace scanner audit: ${error instanceof Error ? error.message : String(error)}`);
}

const violations = Object.entries(audit.hits ?? {}).flatMap(([name, hits]) =>
  Array.isArray(hits) && hits.length > 0 ? hits.map((path) => `${name}: ${path}`) : [],
);

if (violations.length > 0) {
  console.error('[mempalace-scan-artifact-audit] generated/local paths would be scanned:');
  for (const violation of violations.slice(0, 50)) console.error(`- ${violation}`);
  if (violations.length > 50) console.error(`- ... ${violations.length - 50} more`);
  process.exit(2);
}

console.log(
  `[mempalace-scan-artifact-audit] PASS scannedFiles=${audit.scannedFiles} artifactHits=0 mempalace=${mempalacePath}`,
);
