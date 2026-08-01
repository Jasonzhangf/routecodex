#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const projectFiles = [
  'AGENTS.md',
  '.agents/skills/rcc-dev-skills/SKILL.md',
  '.agents/skills/rcc-v3-architecture/SKILL.md',
  '.agents/skills/rcc-server-restart/SKILL.md',
];
const globalFiles = [
  resolve(homedir(), '.codex/AGENTS.md'),
  resolve(homedir(), '.codex/skills/coding-principals/SKILL.md'),
  resolve(homedir(), '.codex/skills/pipedebug/SKILL.md'),
  resolve(homedir(), '.agents/skills/rcc-v3-config-ssot/SKILL.md'),
];
const globalReviewFiles = [
  resolve(homedir(), '.claude/skills/codex-review/SKILL.md'),
  resolve(homedir(), '.claude/skills/codex-review/review-prompt.md'),
];
const includeGlobal = process.argv.includes('--include-global');
const files = includeGlobal ? [...projectFiles, ...globalFiles] : projectFiles;
const batchReplacementRequired = [
  /P0.*禁止脚本批量替换|禁止脚本批量替换/iu,
  /(?:绝对禁止|严禁).*Python.*Node.*Perl.*sed.*awk/iu,
  /临时脚本.*shell loop.*正则替换命令.*编辑器宏.*transformation script/iu,
  /跨文件.*同一文件多位置.*语义批量替换/iu,
  /(?:逐文件|每个目标文件).*读取.*核实上下文/iu,
  /apply_patch.*hunk/iu,
  /formatter.*canonical generator.*(?:声明|declared).*(?:机械|生成产物)/iu,
  /(?:不得|绝不能).*语义改写/iu,
];
const required = [
  /P0.*(?:控制|架构阻断|Architecture Guard)/iu,
  /typed (?:carrier|side-channel)|typed control resource|MetadataCenter.*控制资源/iu,
  /绝不能.*(?:payload|request\/response)|never enter.*payload/iu,
  /payload.*不得.*重建|must not.*reconstruct.*control/iu,
  /fail-fast/iu,
  /silent strip/iu,
  /请求侧 (?:cleanup|清理)|request-side cleanup/iu,
  /handler\/SSE\/outbound|transport\/handler\/outbound/iu,
];
const moduleReviewRequired = [
  /模块.*定义|module definitions?/iu,
  /owner/iu,
  /allowed\/forbidden|allowed.*forbidden/iu,
  /相邻.*(?:调用)?边|adjacent.*(?:call|edge)/iu,
  /资源关系|资源边|resource relations?/iu,
  /方案.*越界|design.*boundary/iu,
  /diff.*越界|实现后.*越界|写完.*越界|修改后.*越界|actual diff.*boundary/iu,
  /功能验证|验证功能|functional verification/iu,
  /(?:最后|才).*code review|code review.*(?:最后|only after|last)|(?:功能验证|验证功能).*code review/iu,
];

const failures = [];
for (const file of files) {
  if (!existsSync(file)) {
    failures.push(`${file}: required P0 guard surface is missing`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  const firstScreenLines = source.split(/\r?\n/u).slice(0, 40);
  const firstScreen = firstScreenLines.join('\n');
  const p0Start = firstScreenLines.findIndex((line) => /P0.*(?:禁止脚本批量替换|控制|架构阻断|Architecture Guard)/iu.test(line));
  const p0End = firstScreenLines.findIndex((line, index) => index > p0Start
    && (/^##\s+/u.test(line) || /^1\. \*\*/u.test(line)));
  const p0Surface = p0Start >= 0
    ? firstScreenLines.slice(p0Start, p0End >= 0 ? p0End : firstScreenLines.length).join('\n')
    : '';
  for (const pattern of batchReplacementRequired) {
    if (!pattern.test(p0Surface)) {
      failures.push(`${file}: first 40 lines missing P0 no-script-batch-replacement guard ${pattern}`);
    }
  }
  for (const pattern of required) {
    if (!pattern.test(p0Surface)) {
      failures.push(`${file}: first 40 lines missing P0 payload/control guard ${pattern}`);
    }
  }
  for (const pattern of moduleReviewRequired) {
    if (!pattern.test(p0Surface)) {
      failures.push(`${file}: first 40 lines missing module-boundary review sequence ${pattern}`);
    }
  }
  const batchIndex = firstScreen.search(/禁止脚本批量替换/iu);
  const payloadIndex = firstScreen.search(/控制面与业务 payload|控制语义绝不进入业务 payload|控制语义只能走|RouteCodex 控制语义只能走|配置.*控制|控制面与业务数据面物理隔离/iu);
  const p0Index = firstScreen.search(/P0.*(?:禁止脚本批量替换|控制|架构阻断|Architecture Guard)/iu);
  const routingIndex = firstScreen.search(/## (?:何时用|Trigger|先读|核心知识|技能概述|分类路由)|1\. \*\*/u);
  if (p0Index < 0 || (routingIndex >= 0 && p0Index > routingIndex)) {
    failures.push(`${file}: P0 payload/control guard must appear before routing or workflow content`);
  }
  if (batchIndex < 0 || (payloadIndex >= 0 && batchIndex > payloadIndex)) {
    failures.push(`${file}: P0 no-script-batch-replacement guard must appear before payload/control rules`);
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const umbrella = readFileSync('scripts/architecture/verify-v3-architecture-ci.mjs', 'utf8');
for (const script of [
  'verify:agent-p0-payload-control-guard',
  'test:agent-p0-payload-control-guard-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(`package.json: missing ${script}`);
  if (!umbrella.includes(`'${script}'`)) failures.push(`verify:v3-architecture-ci: missing ${script}`);
}

if (includeGlobal) {
  const reviewBatchRequired = [
    /禁止脚本批量替换/iu,
    /Python.*Node.*Perl.*sed.*awk/iu,
    /临时脚本.*shell loop.*正则替换命令.*编辑器宏.*transformation script/iu,
    /跨文件.*同一文件多位置.*语义批量替换/iu,
    /apply_patch.*hunk/iu,
    /formatter.*canonical generator/iu,
    /(?:不得|绝不能|FAIL).*语义改写/iu,
  ];
  for (const file of globalReviewFiles) {
    if (!existsSync(file)) {
      failures.push(`${file}: required Codex review P0 guard surface is missing`);
      continue;
    }
    const source = readFileSync(file, 'utf8');
    for (const pattern of reviewBatchRequired) {
      if (!pattern.test(source)) failures.push(`${file}: missing P0 no-script-batch-replacement review lock ${pattern}`);
    }
  }
  const reviewRequired = [
    /P0.*禁止脚本批量替换|P0-BATCH-REWRITE/iu,
    /Python.*Node.*Perl.*sed.*awk/iu,
    /apply_patch.*hunk/iu,
    /formatter.*canonical generator/iu,
    /Code review 是最后一道门禁|P0 前置：模块定义绑定/iu,
    /resource map/iu,
    /function map/iu,
    /mainline call map/iu,
    /module registry/iu,
    /verification map/iu,
    /owned\/allowed\/forbidden paths/iu,
    /相邻 caller\/callee/iu,
    /资源关系/iu,
    /P0-MODULE-BOUNDARY/iu,
    /MODULE_BOUNDARY_EVIDENCE/iu,
  ];
  const combined = globalReviewFiles.map((file) => existsSync(file) ? readFileSync(file, 'utf8') : '').join('\n');
  for (const pattern of reviewRequired) {
    if (!pattern.test(combined)) failures.push(`codex-review surfaces missing module-boundary requirement ${pattern}`);
  }
}

if (failures.length) {
  console.error('[verify:agent-p0-payload-control-guard] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[verify:agent-p0-payload-control-guard] ok (${files.length} entry surfaces)`);
