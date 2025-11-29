#!/usr/bin/env node
/**
 * Analyze file-related tool invocations (edit/create/delete), and list
 * request-side provided tool sets for those invocations. Excludes records
 * with no tool calls in the response.
 *
 * Usage:
 *   node scripts/analyze-tools-fileops.mjs [baseDir] [outDir]
 * Defaults:
 *   baseDir = ~/.routecodex/codex-samples
 *   outDir  = ./reports
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const baseDir = process.argv[2] || path.join(os.homedir(), '.routecodex', 'codex-samples');
const outDir = process.argv[3] || path.join(process.cwd(), 'reports');

function isJson(f){ return f.toLowerCase().endsWith('.json'); }
function readJson(f){ try { return JSON.parse(fs.readFileSync(f,'utf-8')); } catch { return null; } }
function unwrap(o){
  if (!o || typeof o !== 'object') return o;
  if (o.data && typeof o.data === 'object') {
    const d = o.data;
    if (d.body && typeof d.body === 'object') return d.body;
    if (typeof d.bodyText === 'string') { try { return JSON.parse(d.bodyText); } catch { return o; } }
    return d;
  }
  if (o.body && typeof o.body === 'object') return o.body;
  return o;
}
function ridFrom(name){ const m = name.match(/^(req_[^_]+_[^_]+)_/); return m ? m[1] : null; }
function uniqSorted(iter){ return Array.from(new Set(iter)).sort((a,b)=>a.localeCompare(b)); }
function setKey(set){ return uniqSorted(set).join(';'); }

// Tool categories
const EDIT_TOOLS = new Set(['Edit','apply_patch','StrReplaceFile','StrReplace','Replace','NotebookEdit']);
const CREATE_TOOLS = new Set(['Write','WriteFile','Create','CreateFile']);
const DELETE_TOOLS = new Set(['Delete','DeleteFile']);
const SHELL_TOOLS = new Set(['shell','Shell','Bash','bash']);
const SH_EDIT   = ['sed -i','perl -pi',' ed ',' ex ',' patch ','applypatch','apply_patch'];
const SH_CREATE = ['touch ',' tee ',' > ',' >> ','install -D','cat >','printf >','echo '];
const SH_DELETE = ['rm ','rm -','unlink ','rmdir '];
const incAny = (s, arr) => { const t = s.toLowerCase(); return arr.some(p => t.includes(p)); };

function collectProvided(obj, bag){
  try {
    const tools = obj?.tools;
    if (Array.isArray(tools)) for (const t of tools){ const n = t?.function?.name || t?.name; if (n) bag.add(n); }
  } catch {}
}
function _payload(obj){
  if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') return obj.data;
  return obj;
}
function collectSelected(obj, bag){
  obj = _payload(obj);
  // OpenAI Chat tool_calls
  try {
    const choices = Array.isArray(obj?.choices) ? obj.choices : [];
    for (const ch of choices){ const tcs = ch?.message?.tool_calls; if (Array.isArray(tcs)) for (const call of tcs){ const n = call?.function?.name || call?.name; if (n) bag.add(n); } }
  } catch {}
  // Anthropic tool_use
  try {
    const content = Array.isArray(obj?.content) ? obj.content : [];
    for (const part of content){ if (part && typeof part === 'object' && part.type === 'tool_use'){ const n = part?.name; if (n) bag.add(n); } }
  } catch {}
}
function detectOpsFromSelected(obj){
  obj = _payload(obj);
  const out = { edit:false, create:false, delete:false };
  try {
    const choices = Array.isArray(obj?.choices) ? obj.choices : [];
    for (const ch of choices){ const tcs = ch?.message?.tool_calls; if (Array.isArray(tcs)) for (const call of tcs){ const n = (call?.function?.name || call?.name || ''); const args = String(call?.function?.arguments ?? ''); if (EDIT_TOOLS.has(n)) out.edit = true; if (CREATE_TOOLS.has(n)) out.create = true; if (DELETE_TOOLS.has(n)) out.delete = true; if (SHELL_TOOLS.has(n)){ if (incAny(args, SH_EDIT)) out.edit = true; if (incAny(args, SH_CREATE)) out.create = true; if (incAny(args, SH_DELETE)) out.delete = true; } } }
  } catch {}
  try {
    const content = Array.isArray(obj?.content) ? obj.content : [];
    for (const part of content){ if (part && typeof part === 'object' && part.type === 'tool_use'){ const n=(part?.name||''); const args = JSON.stringify(part?.input ?? {}); if (EDIT_TOOLS.has(n)) out.edit = true; if (CREATE_TOOLS.has(n)) out.create = true; if (DELETE_TOOLS.has(n)) out.delete = true; if (SHELL_TOOLS.has(n)){ if (incAny(args, SH_EDIT)) out.edit = true; if (incAny(args, SH_CREATE)) out.create = true; if (incAny(args, SH_DELETE)) out.delete = true; } } }
  } catch {}
  return out;
}
function guessPortFromJson(obj){
  let port = null;
  const stack = [obj];
  while (stack.length){
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (typeof v.port === 'number' && v.port > 0) return v.port;
    for (const k of Object.keys(v)){
      const val = v[k];
      if (typeof val === 'string'){
        const m1 = val.match(/virtual-router-config\.(\d{2,5})\.generated\.json/);
        if (m1) return Number(m1[1]);
        const m1b = val.match(/pipeline-config\.(\d{2,5})\.generated\.json/);
        if (m1b) return Number(m1b[1]);
        const m2 = val.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/i);
        if (m2) return Number(m2[1]);
      } else if (val && typeof val === 'object') stack.push(val);
    }
  }
  return port;
}
async function listJsonRec(d){
  const out = [];
  async function walk(p){ let ents; try { ents = await fsp.readdir(p,{withFileTypes:true}); } catch { return; }
    for (const e of ents){ const f = path.join(p,e.name); if (e.isDirectory()) await walk(f); else if (e.isFile() && isJson(e.name)) out.push(f); }
  }
  await walk(d); return out;
}

(async () => {
  if (!fs.existsSync(baseDir)){
    console.error('Base dir not found:', baseDir); process.exit(1);
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const endpoints = fs.readdirSync(baseDir, { withFileTypes:true }).filter(e=>e.isDirectory()).map(e=>e.name);
  const records = [];
  for (const folder of endpoints){
    const dir = path.join(baseDir, folder);
    const files = await listJsonRec(dir);
    const byRid = new Map();
    for (const f of files){
      const base = path.basename(f); if (!base.startsWith('req_')) continue; const rid = ridFrom(base); if (!rid) continue;
      const raw = readJson(f); if (!raw) continue; const obj = unwrap(raw); const low = f.toLowerCase();
      const g = byRid.get(rid) || { provided:new Set(), selected:new Set(), ops:{edit:false,create:false,delete:false}, port:null };
      if (low.includes('request')){
        collectProvided(obj, g.provided);
        const p = guessPortFromJson(raw); if (p) g.port = p;
      }
      if (low.includes('response')){
        collectSelected(obj, g.selected);
        const o = detectOpsFromSelected(obj); g.ops.edit ||= o.edit; g.ops.create ||= o.create; g.ops.delete ||= o.delete;
        const p = guessPortFromJson(raw); if (p) g.port = p;
      }
      if (!low.includes('request') && !low.includes('response')){
        collectProvided(obj, g.provided); collectSelected(obj, g.selected);
        const o = detectOpsFromSelected(obj); g.ops.edit ||= o.edit; g.ops.create ||= o.create; g.ops.delete ||= o.delete;
        const p = guessPortFromJson(raw); if (p) g.port = p;
      }
      byRid.set(rid, g);
    }
    for (const [rid,g] of byRid){
      // Exclude entries without any tool calls in response
      if (g.selected.size === 0) continue;
      records.push({ port: g.port || 'unknown', endpoint: folder, rid, provided:setKey(g.provided), selected:setKey(g.selected), ops:g.ops });
    }
  }
  // Write all calls CSV
  const csvAll = path.join(outDir, 'tool-calls-by-port.csv');
  const rowsAll = ['port,endpoint,rid,provided_tools,selected_tools,is_edit,is_create,is_delete'];
  for (const r of records){ rowsAll.push([r.port,r.endpoint,r.rid,`"${r.provided}"`,`"${r.selected}"`,r.ops.edit?1:0,r.ops.create?1:0,r.ops.delete?1:0].join(',')); }
  fs.writeFileSync(csvAll, rowsAll.join('\n'), 'utf-8');

  // Aggregated for file-op categories only
  const fileOps = records.filter(r=>r.ops.edit||r.ops.create||r.ops.delete);
  const agg = new Map();
  for (const r of fileOps){ const cats = (r.ops.edit?'E':'') + (r.ops.create?'C':'') + (r.ops.delete?'D':''); const key = [r.port,r.endpoint,r.provided,cats].join('|'); agg.set(key,(agg.get(key)||0)+1); }
  const csvAgg = path.join(outDir, 'tool-fileops-agg-by-port.csv');
  const rowsAgg = ['port,endpoint,provided_set,categories,count'];
  for (const [k,c] of Array.from(agg.entries()).sort((a,b)=>b[1]-a[1])){ const [port,endpoint,provided,cats] = k.split('|'); rowsAgg.push([port,endpoint,`"${provided}"`,cats,c].join(',')); }
  fs.writeFileSync(csvAgg, rowsAgg.join('\n'), 'utf-8');

  // Markdown summary
  const md = path.join(outDir, 'tool-fileops-summary.md');
  const total = records.length; const totalFileOps = fileOps.length;
  const byPort = {};
  for (const r of fileOps){ const k = String(r.port); byPort[k] = (byPort[k]||0)+1; }
  const lines = [
    '# Tool Calls Summary (by server port)\n',
    `Total requests with tool calls: ${total}`,
    `File-op requests (edit/create/delete): ${totalFileOps}`,
    '', '## File-op counts by port',
    ...Object.entries(byPort).sort((a,b)=>b[1]-a[1]).map(([p,c])=>`- ${p}: ${c}`),
    '', 'Artifacts:',
    `- ${csvAll}`, `- ${csvAgg}`
  ];
  fs.writeFileSync(md, lines.join('\n'), 'utf-8');
  console.log('Wrote:', csvAll); console.log('Wrote:', csvAgg); console.log('Wrote:', md);
})();
