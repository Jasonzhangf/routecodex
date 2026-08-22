#!/usr/bin/env node
/**
 * Strict tool_call arguments verifier for OpenAI Chat provider-request.json samples.
 *
 * Goals:
 * - Avoid false positives: parse JSON first, then apply per-tool whitelist.
 * - Only flag when arguments are unparseable AND contain obvious markup tokens,
 *   or when parsed args include non-whitelisted keys for known tools.
 * - Unknown tools are tolerated (no error), but we still parse and report keys.
 *
 * Usage:
 *   node scripts/verify-tool-arguments.mjs                # check latest 10 in ~/.routecodex/codex-samples/openai-chat
 *   node scripts/verify-tool-arguments.mjs 5              # check latest 5
 *   node scripts/verify-tool-arguments.mjs /path/to.json  # check a single provider-request.json
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const SAMPLES_DIR = path.join(HOME, '.routecodex', 'codex-samples', 'openai-chat');

const ALLOWED_KEYS = {
  shell: new Set(['command','justification','timeout_ms','with_escalated_permissions','workdir']),
  apply_patch: new Set(['patch','input']),
  update_plan: new Set(['explanation','plan']),
  view_image: new Set(['path']),
  list_mcp_resources: new Set(['server','cursor','filter','root']),
  read_mcp_resource: new Set(['server','uri','cursor']),
  list_mcp_resource_templates: new Set(['server','cursor'])
};

const MARKUP_TOKENS = [
  '空的',
  '<tool_call>',
  '<function=execute>',
  '*** Begin Patch',
  '*** End Patch'
];

function normalizeKey(k) {
  try {
    const t = String(k || '').trim();
    if (!t) return '';
    const m = t.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    return m ? m[1] : t;
  } catch { return String(k || ''); }
}

function hasMarkupTokens(s) {
  if (typeof s !== 'string') return false;
  const t = s;
  return MARKUP_TOKENS.some(tok => t.includes(tok));
}

function parseJson(str) {
  try { return { ok: true, value: JSON.parse(str) }; } catch (e) { return { ok: false, error: e }; }
}

function listLatestProviderRequests(n = 10) {
  try {
    const files = fs.readdirSync(SAMPLES_DIR)
      .filter(f => /_provider-request\.json$/.test(f))
      .map(f => ({ f, p: path.join(SAMPLES_DIR, f), t: fs.statSync(path.join(SAMPLES_DIR, f)).mtimeMs }))
      .sort((a,b) => b.t - a.t)
      .slice(0, n)
      .map(x => x.p);
    return files;
  } catch {
    return [];
  }
}

function collectAssistantToolCalls(request) {
  const msgs = Array.isArray(request?.messages) ? request.messages : [];
  const all = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if ((m.role === 'assistant') && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name || tc?.name;
        const argsRaw = tc?.function?.arguments ?? tc?.arguments ?? '{}';
        const id = tc?.id || tc?.call_id;
        all.push({ id, name, argsRaw });
      }
    }
  }
  return all;
}

function verifyOneToolCall(call) {
  const nameRaw = typeof call.name === 'string' ? call.name : '';
  const name = nameRaw.includes('.') ? nameRaw.slice(nameRaw.indexOf('.') + 1) : nameRaw;
  const allowed = ALLOWED_KEYS[name] || null;
  const argsStr = typeof call.argsRaw === 'string' ? call.argsRaw : JSON.stringify(call.argsRaw ?? {});
  const parsed = parseJson(argsStr);
  const report = { id: call.id, name, ok: true, reason: '', unknownKeys: [], keys: [], rawLength: argsStr.length };
  if (!parsed.ok) {
    // only flag when unparseable AND contains obvious markup tokens (to suppress false positives)
    if (hasMarkupTokens(argsStr)) {
      report.ok = false;
      report.reason = 'unparseable_with_markup';
      return report;
    }
    // else: treat as non-fatal (do not flag as error), but record reason for info
    report.reason = 'unparseable_no_markup';
    return report;
  }
  const obj = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const keys = Object.keys(obj || {}).map(normalizeKey);
  report.keys = keys;
  if (allowed) {
    const extras = keys.filter(k => !allowed.has(k));
    if (extras.length) {
      report.ok = false;
      report.reason = 'unknown_keys_for_known_tool';
      report.unknownKeys = extras;
    }
  }
  return report;
}

function verifyRequestFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const req = JSON.parse(raw);
    const toolCalls = collectAssistantToolCalls(req);
    const reports = toolCalls.map(verifyOneToolCall);
    const errors = reports.filter(r => !r.ok);
    const summary = {
      file,
      total_tool_calls: toolCalls.length,
      errors_count: errors.length,
      errors,
      // keep non-fatal info for transparency
      info_unparseable_no_markup: reports.filter(r => r.reason === 'unparseable_no_markup').length
    };
    return summary;
  } catch (e) {
    return { file, total_tool_calls: 0, errors_count: 1, errors: [{ ok:false, reason: 'file_parse_error', message: String(e?.message || e) }], info_unparseable_no_markup: 0 };
  }
}

async function main() {
  const arg = process.argv[2];
  let files = [];
  if (!arg) files = listLatestProviderRequests(10);
  else if (/^\d+$/.test(arg)) files = listLatestProviderRequests(parseInt(arg,10));
  else files = [arg];
  if (!files.length) {
    console.log('[verify] no provider-request.json found.');
    process.exit(0);
  }
  let totalErrors = 0;
  for (const f of files) {
    const s = verifyRequestFile(f);
    const header = `\n== ${path.basename(f)} ==`;
    console.log(header);
    console.log(`total_tool_calls: ${s.total_tool_calls}`);
    if (s.errors_count) {
      console.log(`errors_count: ${s.errors_count}`);
      for (const e of s.errors) {
        console.log(` - id:${e.id || '-'} name:${e.name || '-'} reason:${e.reason} ${e.unknownKeys && e.unknownKeys.length ? `unknown_keys:${e.unknownKeys.join(',')}` : ''}`);
      }
      totalErrors += s.errors_count;
    } else {
      console.log('errors_count: 0');
    }
    if (s.info_unparseable_no_markup) {
      console.log(`note: unparseable_no_markup (non-fatal): ${s.info_unparseable_no_markup}`);
    }
  }
  // Do not exit non-zero unless confirmed issues exist (prevents false positive CI breaks)
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
