#!/usr/bin/env node
// Audit captured RouteCodex samples for tool-call field correctness
// - Scans ~/.routecodex/codex-samples
// - For pipeline-in-anth_*.json (Anthropic request captures):
//   * Inspect tool_use blocks: detect missing required fields by tool
//   * Count empty inputs (e.g., {}) and multi-tool per message
// - For provider-out-openai_*.json (OpenAI provider responses):
//   * Inspect tool_calls: check arguments string presence and JSON parse validity
// Prints a concise summary and a CSV with details.

import fs from 'node:fs/promises';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples');

const reqFieldsByTool = {
  write: ['file_path', 'content'],
  read: ['file_path'],
  edit: ['file_path', 'old_string', 'new_string'],
  glob: ['pattern'],
  search: ['pattern'],
};

function missingRequired(name, input) {
  const req = reqFieldsByTool[name.toLowerCase()];
  if (!req) return [];
  const misses = [];
  for (const k of req) { if (!(input && Object.prototype.hasOwnProperty.call(input, k))) misses.push(k); }
  return misses;
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function listFiles(prefix) {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort((a,b)=>{
      const aa = a.match(/_(\d{10,})/); const bb = b.match(/_(\d{10,})/);
      const ta = aa?Number(aa[1]):0, tb = bb?Number(bb[1]):0; return tb-ta;
    }).map(f => path.join(dir,f));
  } catch { return []; }
}

async function auditPipelineInAnth(p) {
  const j = await readJson(p); if (!j) return null;
  const messages = j?.data?.messages; if (!Array.isArray(messages)) return null;
  let toolCount = 0, emptyInputs = 0, msgMulti = 0, issues = 0;
  const details = [];
  for (const m of messages) {
    const content = Array.isArray(m?.content) ? m.content : [];
    const tools = content.filter(x => x && x.type === 'tool_use');
    if (tools.length > 1) msgMulti++;
    for (const t of tools) {
      toolCount++;
      const name = String(t.name || '').trim();
      const input = (t.input && typeof t.input === 'object') ? t.input : {};
      if (!input || Object.keys(input).length === 0) { emptyInputs++; issues++; details.push({ kind:'empty_input', name }); continue; }
      const miss = missingRequired(name, input);
      if (miss.length) { issues++; details.push({ kind:'missing', name, missing: miss }); }
    }
  }
  return { file: path.basename(p), toolCount, emptyInputs, msgMulti, issues, details };
}

async function auditProviderOut(p) {
  const j = await readJson(p); if (!j) return null;
  const choice = Array.isArray(j?.choices) ? j.choices[0] : null; if (!choice) return null;
  const msg = choice.message || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  let badArgs = 0, nonStringArgs = 0, parsedErrors = 0;
  for (const tc of calls) {
    const fn = tc?.function || {};
    if (!('arguments' in fn)) { badArgs++; continue; }
    if (typeof fn.arguments !== 'string') { nonStringArgs++; continue; }
    const s = fn.arguments;
    try { JSON.parse(s); } catch { parsedErrors++; }
  }
  return { file: path.basename(p), toolCalls: calls.length, badArgs, nonStringArgs, parsedErrors };
}

async function main() {
  const anth = await listFiles('pipeline-in-anth_');
  const out = await listFiles('provider-out-openai_');
  const limit = Number(process.env.AUDIT_LIMIT || 50);
  const anthUse = anth.slice(0, limit);
  const outUse = out.slice(0, limit);

  const anthResults = (await Promise.all(anthUse.map(auditPipelineInAnth))).filter(Boolean);
  const outResults = (await Promise.all(outUse.map(auditProviderOut))).filter(Boolean);

  let totalTools = 0, totalEmpty = 0, totalMulti = 0, totalIssues = 0;
  for (const r of anthResults) { totalTools += r.toolCount; totalEmpty += r.emptyInputs; totalMulti += r.msgMulti; totalIssues += r.issues; }
  console.log('Anthropic pipeline-in audit summary');
  console.log(` samples=${anthResults.length} tools=${totalTools} emptyInputs=${totalEmpty} multiToolsMsgs=${totalMulti} issues=${totalIssues}`);

  let outCalls = 0, outBad = 0, outNonStr = 0, outParseErr = 0;
  for (const r of outResults) { outCalls += r.toolCalls; outBad += r.badArgs; outNonStr += r.nonStringArgs; outParseErr += r.parsedErrors; }
  console.log('Provider-out OpenAI audit summary');
  console.log(` samples=${outResults.length} toolCalls=${outCalls} badArgs=${outBad} nonStringArgs=${outNonStr} parseErrors=${outParseErr}`);

  const csv = ['file,kind,tool,missing'];
  for (const r of anthResults) {
    for (const d of r.details) {
      csv.push([r.file, d.kind, d.name || '', (d.missing||[]).join('|')].join(','));
    }
  }
  const outCsv = ['file,toolCalls,badArgs,nonStringArgs,parseErrors'];
  for (const r of outResults) outCsv.push([r.file,r.toolCalls,r.badArgs,r.nonStringArgs,r.parsedErrors].join(','));
  await fs.mkdir('tmp', { recursive: true });
  await fs.writeFile('tmp/audit-pipeline-in.csv', csv.join('\n'));
  await fs.writeFile('tmp/audit-provider-out.csv', outCsv.join('\n'));
  console.log('CSV written: tmp/audit-pipeline-in.csv, tmp/audit-provider-out.csv');
}

main().catch(err => { console.error(err); process.exit(1); });

