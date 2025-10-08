#!/usr/bin/env node
// Audit Anthropic requests (pipeline-in-anth_*.json) using schema-arg-normalizer
// For each tool_use, validate input against matching tool's input_schema and report invalid/missing.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples');

function listFiles(prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).map(f => path.join(dir, f));
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function importNormalizer() {
  const distPath = path.resolve(process.cwd(), 'dist/modules/pipeline/utils/schema-arg-normalizer.js');
  if (!fs.existsSync(distPath)) {
    console.error('Build missing. Run: npm run build');
    process.exit(1);
  }
  return await import(url.pathToFileURL(distPath).href);
}

function findSchema(tools, name) {
  if (!Array.isArray(tools)) return null;
  const t = tools.find(z => String(z?.name||'').toLowerCase() === String(name||'').toLowerCase());
  return t?.input_schema || null;
}

function analyzeFile(p, normalize) {
  const j = readJSON(p);
  if (!j) return null;
  const payload = j.data ?? j;
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const summary = { file: path.basename(p), total: 0, invalid: 0, missing: 0, perTool: {} };
  for (const m of msgs) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const b of content) {
      if (!(b && b.type === 'tool_use')) continue;
      summary.total++;
      const name = b.name || 'tool';
      const schema = findSchema(tools, name) || {};
      const input = b.input;
      const n = normalize(input, schema);
      const ok = n.ok && n.value && Object.keys(n.value).length > 0;
      if (!summary.perTool[name]) summary.perTool[name] = { count: 0, invalid: 0, missing: 0 };
      summary.perTool[name].count++;
      if (!ok) {
        summary.invalid++;
        summary.perTool[name].invalid++;
        const missList = Array.isArray(n?.errors) ? n.errors.filter(e => String(e).startsWith('missing_required:')) : [];
        const missing = missList.length;
        summary.missing += missing;
        summary.perTool[name].missing += missing;
        if (missing) {
          summary.perTool[name].missing_list = summary.perTool[name].missing_list || {};
          for (const e of missList) {
            const k = e.split(':')[1] || e;
            summary.perTool[name].missing_list[k] = (summary.perTool[name].missing_list[k] || 0) + 1;
          }
        }
      }
    }
  }
  return summary;
}

async function main() {
  const { normalizeArgsBySchema } = await importNormalizer();
  const files = listFiles('pipeline-in-anth_');
  if (files.length === 0) {
    console.log('No pipeline-in-anth_* files.');
    process.exit(0);
  }
  const rows = [['file','total','invalid','missing_required','per_tool_json']];
  let agg = { total: 0, invalid: 0, missing: 0 };
  for (const f of files.slice(-200)) {
    const r = analyzeFile(f, normalizeArgsBySchema);
    if (!r) continue;
    agg.total += r.total; agg.invalid += r.invalid; agg.missing += r.missing;
    rows.push([r.file, r.total, r.invalid, r.missing, JSON.stringify(r.perTool)].join(','));
  }
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/audit-anthropic-requests.csv', rows.join('\n'));
  console.log('Audit summary (last 200 Anthropic requests):');
  console.log(` total_tool_use=${agg.total}, invalid=${agg.invalid}, missing_required=${agg.missing}`);
  console.log('CSV written: tmp/audit-anthropic-requests.csv');
}

main().catch(e => { console.error('audit-anthropic-requests failed:', e); process.exit(1); });
