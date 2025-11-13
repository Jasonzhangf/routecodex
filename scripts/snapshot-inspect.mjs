#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { endpoint: null, rid: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--endpoint' || a === '-e') && i + 1 < argv.length) { args.endpoint = argv[++i]; continue; }
    if ((a === '--rid' || a === '-r') && i + 1 < argv.length) { args.rid = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function topKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).sort();
}

function hasKey(obj, k) { return !!obj && typeof obj === 'object' && k in obj; }

function summarizeMessages(payload) {
  const out = { count: 0, roles: {}, hasUser: false };
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  out.count = msgs.length;
  for (const m of msgs) {
    const r = (m && typeof m.role === 'string') ? m.role : 'unknown';
    out.roles[r] = (out.roles[r] || 0) + 1;
    if (r === 'user') out.hasUser = true;
  }
  return out;
}

function diffKeys(a, b) {
  const A = new Set(a || []); const B = new Set(b || []);
  const added = [...B].filter(k => !A.has(k));
  const removed = [...A].filter(k => !B.has(k));
  return { added, removed };
}

async function readJson(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.rid) {
    console.log('Usage: node scripts/snapshot-inspect.mjs --rid <RID> [--endpoint <dir>]');
    console.log('  endpoint: openai-responses | openai-chat | anthropic-messages (auto when omitted)');
    process.exit(args.help ? 0 : 1);
  }

  const HOME = process.env.HOME || process.env.USERPROFILE || '';
  const root = path.join(HOME, '.routecodex', 'codex-samples');
  const endpoints = args.endpoint ? [args.endpoint] : ['openai-responses','openai-chat','anthropic-messages'];
  let baseDir = null;
  for (const ep of endpoints) {
    const d = path.join(root, ep);
    try { await fs.access(d); baseDir = d; break; } catch {}
  }
  if (!baseDir) {
    console.error('No endpoint directory found under', root);
    process.exit(2);
  }

  const rid = args.rid;
  const files = [
    `${rid}_http-request.json`,
    `${rid}_http-request.parsed.json`,
    `${rid}_pipeline.llmswitch.request.post.json`,
    `${rid}_pipeline.compatibility.request.post.json`,
    `${rid}_pipeline.provider.request.pre.json`,
    `${rid}_pipeline.provider.response.json`,
  ];

  const records = [];
  for (const name of files) {
    const p = path.join(baseDir, name);
    const obj = await readJson(p);
    if (!obj) continue;
    const keys = topKeys(obj?.data?.payload || obj);
    const payload = obj?.data?.payload || obj;
    const msg = summarizeMessages(payload);
    const flags = {
      has_data: hasKey(payload, 'data'),
      has_metadata: hasKey(payload, 'metadata'),
      has_stream: hasKey(payload, 'stream'),
      has_messages: hasKey(payload, 'messages'),
    };
    records.push({ name, path: p, keys, msg, flags });
  }

  if (!records.length) {
    console.error('No snapshots found for RID:', rid, 'under', baseDir);
    process.exit(3);
  }

  console.log('Endpoint dir:', baseDir);
  for (const r of records) {
    console.log(`\n=== ${r.name} ===`);
    console.log('- path:', r.path);
    console.log('- topKeys:', r.keys.join(', ') || '(none)');
    console.log(`- messages: count=${r.msg.count}, roles=${JSON.stringify(r.msg.roles)}, hasUser=${r.msg.hasUser}`);
    const suspicious = [];
    if (r.flags.has_data) suspicious.push('data');
    if (r.flags.has_metadata) suspicious.push('metadata');
    if (r.flags.has_stream) suspicious.push('stream');
    if (suspicious.length) console.log('- suspiciousTopLevel:', suspicious.join(', '));
  }

  const byName = Object.fromEntries(records.map(r => [r.name, r]));
  const pairs = [
    ['llmswitch', 'compatibility'],
    ['compatibility', 'provider'],
  ];
  const resolve = (prefix) => Object.keys(byName).find(k => k.includes(prefix));
  for (const [a, b] of pairs) {
    const A = byName[resolve(`${a}.request.post`) || resolve(`${a}.request`)] || byName[resolve(a)] || null;
    const B = byName[resolve(`${b}.request.pre`) || resolve(`${b}.request`)] || byName[resolve(b)] || null;
    if (A && B) {
      const d = diffKeys(A.keys, B.keys);
      console.log(`\n--- Diff: ${A.name} -> ${B.name} ---`);
      if (d.added.length) console.log('  added to later:', d.added.join(', '));
      if (d.removed.length) console.log('  removed in later:', d.removed.join(', '));
      if (!d.added.length && !d.removed.length) console.log('  (no top-level key changes)');
    }
  }
}

main().catch(err => { console.error(err); process.exit(99); });

