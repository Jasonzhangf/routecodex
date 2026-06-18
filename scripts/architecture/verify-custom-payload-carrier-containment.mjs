import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = process.cwd();

const scanRoots = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
];

const skipDirNames = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const allowedExtensions = new Set([
  '.js',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

const manifestPath = path.join(repoRoot, 'docs/architecture/custom-payload-carrier-runtime-manifest.yml');
const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestGroups = new Map(
  (Array.isArray(manifest.carrier_runtime_surfaces) ? manifest.carrier_runtime_surfaces : []).map((group) => [
    String(group.carrier_id),
    group,
  ])
);

function manifestAllowedFiles(carrierId) {
  const group = manifestGroups.get(carrierId);
  return new Set(
    Array.isArray(group?.files)
      ? group.files.map((entry) => String(entry.path || '')).filter(Boolean)
      : []
  );
}

const rules = [
  {
    id: 'routecodex_prefix',
    title: '__routecodex* runtime containment',
    regex: /__routecodex[A-Za-z0-9_]*/g,
    allowedFiles: manifestAllowedFiles('routecodex_prefix'),
  },
  {
    id: 'sse_prefix',
    title: '__sse_* runtime containment',
    regex: /__sse_[A-Za-z0-9_]*/g,
    allowedFiles: new Set(),
  },
  {
    id: 'response_metadata',
    title: 'response.metadata runtime containment',
    regex: /\bresponse\.metadata\b/g,
    allowedFiles: manifestAllowedFiles('response_metadata'),
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirNames.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
const seenByRule = new Map(rules.map((rule) => [rule.id, new Set()]));

for (const scanRoot of scanRoots) {
  for (const file of walk(path.join(repoRoot, scanRoot))) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const rule of rules) {
      if (!rule.regex.test(text)) {
        rule.regex.lastIndex = 0;
        continue;
      }
      rule.regex.lastIndex = 0;
      seenByRule.get(rule.id)?.add(rel);
      if (rule.allowedFiles.has(rel)) {
        continue;
      }
      lines.forEach((line, index) => {
        const matches = [...line.matchAll(rule.regex)];
        if (matches.length === 0) {
          return;
        }
        violations.push({
          rule: rule.id,
          file: rel,
          line: index + 1,
          matches: matches.map((match) => match[0]),
        });
      });
    }
  }
}

if (violations.length > 0) {
  console.error('[verify:custom-payload-carrier-containment] found runtime carrier spread outside allowlist');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${violation.matches.join(', ')}`);
  }
  process.exit(1);
}

console.log('[verify:custom-payload-carrier-containment] ok');
for (const rule of rules) {
  const files = [...(seenByRule.get(rule.id) ?? new Set())].sort();
  console.log(`- ${rule.id}: ${files.length} allowlisted runtime files`);
}
