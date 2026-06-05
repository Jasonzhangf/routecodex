import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'docs/architecture/fallback-denylist.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function listFiles(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '__tests__') continue;
        stack.push(next);
      } else if (config.extensions.includes(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const patterns = config.denyPatterns.map((source) => new RegExp(source, 'i'));
const failures = [];

for (const relRoot of config.targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      for (const pattern of patterns) {
        if (!pattern.test(line)) continue;
        const allowed = (config.allowlist || []).some(
          (entry) => relFile.includes(entry.pathContains) && line.includes(entry.textContains)
        );
        if (!allowed) {
          failures.push(`${relFile}:${idx + 1}: ${line.trim()}`);
        }
      }
    });
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-fallback-denylist] failed');
  failures.slice(0, 80).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 80) console.error(`- ... ${failures.length - 80} more`);
  process.exit(1);
}

console.log('[verify:architecture-fallback-denylist] ok');
console.log(`- checked ${config.targetRoots.length} architecture roots`);
console.log(`- deny patterns: ${config.denyPatterns.length}`);
