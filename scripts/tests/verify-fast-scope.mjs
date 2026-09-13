#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const verifier = join(repo, 'scripts', 'verify-fast.mjs');
const cases = [
  { relative: 'docs/design/gate.md', v3: true, v4: false },
  { relative: 'docs/goals/gate.md', v3: true, v4: false },
  { relative: 'docs/schemas/gate.yml', v3: true, v4: false },
  { relative: '.agents/skills/gate/SKILL.md', v3: false, v4: false },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V3 gate\n    run: npm run verify:v3\n',
    v3: true,
    v4: false,
  },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V4 gate\n    run: npm --prefix v4 run verify:ci\n',
    v3: false,
    v4: true,
  },
  {
    relative: '.github/workflows/test.yml',
    contents: '  timeout-minutes: 10\n',
    v3: true,
    v4: true,
  },
];
const failures = [];

for (const { relative, contents, v3, v4 } of cases) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-verify-fast-scope-'));
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents ?? 'scope fixture\n');
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', relative], { cwd: root });
  const outputPath = join(root, 'scope-output.txt');
  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROUTECODEX_GATE_DIFF_MODE: 'staged',
      ROUTECODEX_GATE_SCOPE_OUTPUT: outputPath,
    },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const scope = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '<missing scope output>';
  if (result.status !== 0 || !scope.includes(`v3=${v3}\n`) || !scope.includes(`v4=${v4}\n`)) {
    failures.push(`${relative}: expected v3=${v3}, v4=${v4}, got status=${result.status}\n${output}`);
  }
}

if (failures.length > 0) {
  console.error('[test:verify-fast-scope] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:verify-fast-scope] ok (${cases.length} scope contracts, including V3-only/V4-only/shared workflow changes)`);
