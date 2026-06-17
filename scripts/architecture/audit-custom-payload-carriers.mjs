import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const scanRoots = [
  'src',
  'tests',
  'scripts',
  'docs/architecture',
  'docs/goals',
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
  '.c',
  '.h',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
]);

const patternGroups = [
  {
    id: 'routecodex_prefix',
    title: '__routecodex* residues',
    regex: /__routecodex[A-Za-z0-9_]*/g,
  },
  {
    id: 'sse_prefix',
    title: '__sse_* residues',
    regex: /__sse_[A-Za-z0-9_]*/g,
  },
  {
    id: 'response_metadata',
    title: 'response.metadata references',
    regex: /\bresponse\.metadata\b/g,
  },
];

function bucketFor(relPath) {
  if (relPath.startsWith('src/') || relPath.startsWith('sharedmodule/llmswitch-core/src/') || relPath.startsWith('sharedmodule/llmswitch-core/rust-core/')) {
    return 'runtime';
  }
  if (relPath.startsWith('tests/')) {
    return 'test';
  }
  if (relPath.startsWith('scripts/')) {
    return 'script';
  }
  if (relPath.startsWith('docs/')) {
    return 'doc';
  }
  return 'other';
}

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

function initGroupState(group) {
  return {
    group,
    bucketCounts: {
      runtime: 0,
      test: 0,
      script: 0,
      doc: 0,
      other: 0,
    },
    files: new Map(),
  };
}

const states = new Map(patternGroups.map((group) => [group.id, initGroupState(group)]));

for (const scanRoot of scanRoots) {
  const absRoot = path.join(repoRoot, scanRoot);
  for (const file of walk(absRoot)) {
    const rel = path.relative(repoRoot, file);
    const bucket = bucketFor(rel);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const group of patternGroups) {
        const matches = [...line.matchAll(group.regex)];
        if (matches.length === 0) {
          continue;
        }
        const state = states.get(group.id);
        if (!state) {
          continue;
        }
        state.bucketCounts[bucket] += matches.length;
        if (!state.files.has(rel)) {
          state.files.set(rel, []);
        }
        const existing = state.files.get(rel);
        if (!existing || existing.length >= 5) {
          continue;
        }
        existing.push({
          line: index + 1,
          matches: matches.map((match) => match[0]),
        });
      }
    }
  }
}

console.log('[audit-custom-payload-carriers] report');

for (const group of patternGroups) {
  const state = states.get(group.id);
  if (!state) {
    continue;
  }
  const files = [...state.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const uniqueFiles = {
    runtime: 0,
    test: 0,
    script: 0,
    doc: 0,
    other: 0,
  };
  for (const [rel] of files) {
    uniqueFiles[bucketFor(rel)] += 1;
  }

  console.log(`\n## ${group.title}`);
  console.log(
    `hits runtime=${state.bucketCounts.runtime} test=${state.bucketCounts.test} script=${state.bucketCounts.script} doc=${state.bucketCounts.doc} other=${state.bucketCounts.other}`
  );
  console.log(
    `files runtime=${uniqueFiles.runtime} test=${uniqueFiles.test} script=${uniqueFiles.script} doc=${uniqueFiles.doc} other=${uniqueFiles.other}`
  );

  for (const [rel, samples] of files.slice(0, 20)) {
    const summary = samples
      .map((sample) => `L${sample.line}:${sample.matches.join(',')}`)
      .join(' | ');
    console.log(`- ${rel} :: ${summary}`);
  }
}
