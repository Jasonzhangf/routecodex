#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');
const SRC_DIR = path.join(ROOT, 'dev', 'src');

const LIMITS = {
  fileLinesError: 500,
  fileLinesWarn: 450,
  funcLinesWarn: 60,
  paramsWarn: 4,
  nestWarn: 3,
  cycloWarn: 10,
};

const issues = [];
const warn = (file, msg) => issues.push({ file, level: 'warn', msg });
const error = (file, msg) => issues.push({ file, level: 'error', msg });

function listTsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push(p);
    }
  })(dir);
  return out;
}

function countLines(p) {
  const txt = fs.readFileSync(p, 'utf-8');
  return txt.split(/\r?\n/).length;
}

function analyzeTs(p) {
  const srcText = fs.readFileSync(p, 'utf-8');
  const sf = ts.createSourceFile(p, srcText, ts.ScriptTarget.Latest, true);

  let maxNest = 0;
  const stack = [];
  function push(kind) { stack.push(kind); maxNest = Math.max(maxNest, stack.length); }
  function pop() { stack.pop(); }

  function getCyclo(node) {
    const text = node.getText(sf);
    const m = text.match(/\b(if|for|while|case|catch)\b|&&|\|\|/g);
    return m ? m.length + 1 : 1;
  }

  function checkFunction(node) {
    // lines
    const { line: start } = sf.getLineAndCharacterOfPosition(node.getStart());
    const { line: end } = sf.getLineAndCharacterOfPosition(node.getEnd());
    const lines = end - start + 1;
    if (lines > LIMITS.funcLinesWarn) warn(p, `函数过长(${lines}行) > ${LIMITS.funcLinesWarn}`);
    // params
    const params = node.parameters ? node.parameters.length : 0;
    if (params > LIMITS.paramsWarn) warn(p, `参数过多(${params}) > ${LIMITS.paramsWarn}`);
    // cyclomatic (approx)
    const cyclo = getCyclo(node);
    if (cyclo > LIMITS.cycloWarn) warn(p, `圈复杂度较高(≈${cyclo}) > ${LIMITS.cycloWarn}`);
  }

  function visit(node) {
    switch (node.kind) {
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.ModuleBlock:
      case ts.SyntaxKind.SourceFile:
        push('block');
        ts.forEachChild(node, visit);
        pop();
        return;
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        checkFunction(node);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (maxNest > LIMITS.nestWarn) warn(p, `嵌套层级较深(${maxNest}) > ${LIMITS.nestWarn}`);
}

function checkReadmes() {
  const modRoot = path.join(SRC_DIR, 'modules');
  if (!fs.existsSync(modRoot)) return;
  for (const dir of fs.readdirSync(modRoot)) {
    const full = path.join(modRoot, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const readme = path.join(full, 'README.md');
    if (!fs.existsSync(readme)) {
      error(full, '缺少模块 README.md（使用 scripts/templates/module-readme-template.md 模板创建）');
    }
  }
}

async function runJscpd() {
  try {
    const res = spawnSync('npx', ['jscpd', '--silent', '--threshold', '5', '--reporters', 'json', '--output', path.join(ROOT, '.jscpd-report'), 'src'], { stdio: 'pipe' });
    if (res.status !== 0) {
      warn('jscpd', '检测到重复代码（请查看 .jscpd-report 目录中的报告）');
    }
  } catch (e) {
    // ignore if jscpd not installed
  }
}

async function main() {
  const files = listTsFiles(SRC_DIR);
  for (const f of files) {
    const lines = countLines(f);
    if (lines >= LIMITS.fileLinesError) {
      error(f, `文件过大(${lines}行) ≥ ${LIMITS.fileLinesError}`);
    } else if (lines > LIMITS.fileLinesWarn) {
      warn(f, `文件偏大(${lines}行) > ${LIMITS.fileLinesWarn}`);
    }
    analyzeTs(f);
  }
  checkReadmes();
  await runJscpd();

  const errors = issues.filter(i => i.level === 'error');
  const warns = issues.filter(i => i.level === 'warn');
  const fmt = (i) => `${i.level.toUpperCase()} ${i.file}: ${i.msg}`;
  if (issues.length) {
    console.log('Module Standards Report');
    for (const i of issues) console.log(' - ' + fmt(i));
  } else {
    console.log('Module Standards Report: OK');
  }
  if (errors.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(2); });
