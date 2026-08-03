#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-agent-p0-payload-control-guard.mjs');
const files = [
  'AGENTS.md',
  '.agents/skills/rcc-dev-skills/SKILL.md',
  '.agents/skills/rcc-v3-architecture/SKILL.md',
  'package.json',
  'scripts/architecture/verify-v3-architecture-ci.mjs',
];
const cases = [
  ['project Agent loses batch replacement ban', 'AGENTS.md', 'P0 禁止脚本批量替换', 'P0 修改工具建议'],
  ['dev skill loses explicit apply_patch requirement', '.agents/skills/rcc-dev-skills/SKILL.md', '`apply_patch` hunk', 'manual edit'],
  ['architecture skill permits ad hoc script replacement', '.agents/skills/rcc-v3-architecture/SKILL.md', '严禁用 Python / Node / Perl', '允许用 Python / Node / Perl'],
  ['project Agent loses fail-fast', 'AGENTS.md', 'owning boundary fail-fast', 'owning boundary fail closed'],
  ['dev skill permits silent strip', '.agents/skills/rcc-dev-skills/SKILL.md', '禁止 silent strip', '允许 silent cleanup'],
  ['architecture skill loses reverse rebuild ban', '.agents/skills/rcc-v3-architecture/SKILL.md', 'normal payload 也不得重建', 'normal payload 可以重建'],
  ['architecture skill runs code review before functional verification', '.agents/skills/rcc-v3-architecture/SKILL.md', '功能验证 -> live 闭环 -> code review', 'code review -> 功能验证 -> live 闭环'],
  ['dev skill loses module forbidden paths review', '.agents/skills/rcc-dev-skills/SKILL.md', 'owned/allowed/forbidden paths', 'owned paths'],
  ['architecture CI drops the P0 entry guard', 'scripts/architecture/verify-v3-architecture-ci.mjs', "  ['verify:agent-p0-payload-control-guard', 'Agent and RouteCodex skill entry surfaces expose the P0 payload/control isolation guard before routing'],\n", ''],
];

const failures = [];
for (const [name, file, from, to] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'agent-p0-guard-red-'));
  try {
    for (const source of files) cpSync(resolve(repoRoot, source), resolve(root, source), { recursive: true });
    const target = resolve(root, file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:agent-p0-payload-control-guard-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:agent-p0-payload-control-guard-red-fixtures] ok (${cases.length} mutations rejected)`);
