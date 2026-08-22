import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'docs/architecture/internal-policy-hardcode-rules.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function normalizeRel(filePath) {
  return filePath.split(path.sep).join('/');
}

function isIgnored(relPath) {
  return normalizeRel(relPath)
    .split('/')
    .some((segment) => config.ignorePathSegments.includes(segment));
}

function collectFiles() {
  const files = [];
  const stack = config.targetRoots.map((entry) => path.join(root, entry));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRel(path.relative(root, absolute));
      if (isIgnored(relative)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (config.extensions.includes(path.extname(relative))) files.push(relative);
    }
  }
  return files.sort();
}

function isAllowed(relative, line, rule) {
  return (config.allowPatterns || []).some(
    (allow) =>
      relative.includes(allow.pathContains || '') &&
      (!allow.pattern || new RegExp(allow.pattern, 'i').test(line)) &&
      (!allow.ruleId || allow.ruleId === rule.id),
  );
}

const failures = [];
for (const relative of collectFiles()) {
  const lines = fs.readFileSync(path.join(root, relative), 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    for (const rule of config.rules) {
      if (new RegExp(rule.pattern, 'i').test(line) && !isAllowed(relative, line, rule)) {
        failures.push({ relative, line: index + 1, rule: rule.id, text: trimmed });
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:internal-policy-hardcode] failed');
  for (const failure of failures.slice(0, 120)) {
    console.error(`- ${failure.relative}:${failure.line} [${failure.rule}] ${failure.text}`);
  }
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:internal-policy-hardcode] ok');
console.log(`- scanned roots: ${config.targetRoots.join(', ')}`);
console.log(`- rules: ${config.rules.length}`);
