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
];
const cases = [
  ['project Agent loses batch replacement ban', 'AGENTS.md', 'P0 禁止脚本批量替换', 'P0 修改工具建议'],
  ['dev skill loses explicit apply_patch requirement', '.agents/skills/rcc-dev-skills/SKILL.md', '逐文件读取核实上下文后用 apply_patch hunk', '逐文件读取核实上下文后手工修改'],
  ['architecture skill permits ad hoc script replacement', '.agents/skills/rcc-v3-architecture/SKILL.md', '严禁用 Python / Node / Perl', '允许用 Python / Node / Perl'],
  [
    'project Agent loses fail-fast',
    'AGENTS.md',
    '发现泄漏必须 fail-fast at owning boundary。\n- 禁止 silent strip、请求侧 cleanup、handler/SSE/outbound 补偿；payload 不得重建控制状态；Stopless 仅保留已登记的同轮 Req04 注入与 Resp03 provenance 剥离例外。\n- 模块定义、owner、allowed/forbidden paths、相邻调用边、资源关系和方案越界必须先审；写完检查实际 diff 越界，再做功能验证，最后才 code review。\n- 泄漏必须在 owning boundary fail-fast',
    '发现泄漏必须 fail closed at owning boundary。\n- 禁止 silent strip、请求侧 cleanup、handler/SSE/outbound 补偿；payload 不得重建控制状态；Stopless 仅保留已登记的同轮 Req04 注入与 Resp03 provenance 剥离例外。\n- 模块定义、owner、allowed/forbidden paths、相邻调用边、资源关系和方案越界必须先审；写完检查实际 diff 越界，再做功能验证，最后才 code review。\n- 泄漏必须在 owning boundary fail closed',
  ],
  ['dev skill permits silent strip', '.agents/skills/rcc-dev-skills/SKILL.md', '禁止 silent strip', '允许 silent cleanup'],
  ['architecture skill loses reverse rebuild ban', '.agents/skills/rcc-v3-architecture/SKILL.md', 'normal payload 也不得重建', 'normal payload 可以重建'],
  ['architecture skill runs code review before functional verification', '.agents/skills/rcc-v3-architecture/SKILL.md', '功能验证 -> live 闭环 -> code review', 'code review -> 功能验证 -> live 闭环'],
  ['dev skill loses module forbidden paths review', '.agents/skills/rcc-dev-skills/SKILL.md', 'allowed/forbidden paths', 'owned paths'],
  ['root V3 architecture dispatcher bypasses V3 ownership', 'package.json', '"verify:v3-architecture-ci": "npm --prefix v3 run verify:v3-architecture-ci"', '"verify:v3-architecture-ci": "node scripts/architecture/verify-v3-architecture-ci.mjs"'],
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
