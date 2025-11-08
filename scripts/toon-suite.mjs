#!/usr/bin/env node
// TOON tool-call probe: sends Chat requests that require arguments.toon, decodes via @toon-format/cli, and summarizes results.

import fetch from 'node-fetch';
import { spawnSync } from 'node:child_process';

function arg(k, d){ const i=process.argv.indexOf(k); return (i>0 && process.argv[i+1]) ? process.argv[i+1] : d; }
function flag(k){ return process.argv.includes(k); }

const server = arg('--server', 'http://127.0.0.1:5520');
const endpoint = arg('--endpoint', '/v1/chat/completions');
const url = `${server.replace(/\/$/,'')}${endpoint}`;
const model = arg('--model', 'glm.glm-4.6');
const doExec = flag('--exec'); // optional local execution (unsafe; whitelist only)

const systemMsg = (
  '当你使用工具 (tool_calls) 时，将 function.arguments 设为 JSON 字符串，且只包含字段 toon（字符串，多行 TOON）。' +
  '不要输出其它字段、不要解释。' +
  '示例：{"toon": "command: bash -lc \'echo ok\'\\nworkdir: .\\n"}。' +
  '务必返回 tool_calls，并仅填充 arguments.toon。'
);

const tools = [
  {
    type: 'function',
    function: {
      name: 'shell_toon',
      description: 'TOON 参数承载：将所有参数用 TOON 字符串放入 arguments.toon',
      parameters: {
        type: 'object',
        properties: { toon: { type: 'string', description: 'TOON-encoded arguments' } },
        required: ['toon'],
        additionalProperties: false
      }
    }
  }
];

const cases = [
  {
    title: 'find_parens_exec',
    user: "请使用 shell_toon：bash -lc 执行：find . -type f \\( -name '*.md' -o -name '*.txt' \\) -exec basename {} \\; | sort -u | head -n 5。只返回 tool_calls。"
  },
  {
    title: 'awk_regex',
    user: "请用 shell_toon：bash -lc 执行：printf 'alpha,error\\nbeta,ok\\n' | awk -F, '{ if (\\$2 ~ /error/) print \\$1 }'。只返回 tool_calls。"
  },
  {
    title: 'sed_replace',
    user: "请用 shell_toon：bash -lc 执行：printf 'a=1\\nb=2\\n' | sed -E 's/([ab])=(\\\\d+)/\\\\1: \\\\2/g'。只返回 tool_calls。"
  },
  {
    title: 'python_heredoc',
    user: `请用 shell_toon：构造“单行” bash -lc 命令来执行多行 Python。禁止在命令中出现真实换行符；改用 ANSI-C 风格 $'...' 在“一行内”嵌入换行(\\n)。示例（仅示意）：bash -lc $'python3 - <<\'PY\'\\nprint(1)\\nPY'。实际请输出：用 $'...' 方式在一行内执行 python3 - <<'PY' 的多行脚本：\nimport json\nprint(json.dumps({"ok": true, "sum": 1+2+3}))\n并保持整条命令为一行。只返回 tool_calls。`
  },
  {
    title: 'xargs_space',
    user: "请用 shell_toon：bash -lc 执行：printf 'A B.md\\nC D.md\\n' | xargs -I{} bash -lc 'echo \"{}\" | tr \" \" _'。只返回 tool_calls。"
  },
  {
    title: 'grep_sort_uniq',
    user: "请用 shell_toon：bash -lc 执行：printf 'a\\nb\\na\\nc\\n' | grep -E '[a-c]' | sort | uniq -c | sort -nr。只返回 tool_calls。"
  }
];

function decodeToon(toonStr){
  const res = spawnSync('npx', ['-y','@toon-format/cli','--decode'], { input: toonStr, encoding: 'utf-8' });
  if ((res.status ?? 0) !== 0) return { ok: false, error: res.stderr || 'decode failed' };
  try { const obj = JSON.parse(res.stdout || '{}'); return { ok: true, value: obj }; } catch (e){ return { ok: false, error: 'json parse failed', raw: res.stdout }; }
}

function safeExec(cmd){
  const allow = /^(bash\s+-lc\s+).*/s.test(cmd) && /(find|printf|awk|sed|python3|ls|sort|head|uniq|tr)/.test(cmd);
  if (!allow) return { ok: false, skipped: true };
  const res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf-8' });
  return {
    ok: true,
    code: res.status ?? 0,
    stdout: (res.stdout || '').split('\n').slice(0, 20).join('\n'),
    stderr: (res.stderr || '').split('\n').slice(0, 20).join('\n')
  };
}

async function runCase(c){
  const payload = {
    model,
    stream: false,
    tool_choice: { type: 'function', function: { name: 'shell_toon' } },
    messages: [ { role: 'system', content: systemMsg }, { role: 'user', content: c.user } ],
    tools
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let body; try { body = await res.json(); } catch { return { title: c.title, status: 'http_error', note: res.statusText }; }
  const msg = body?.choices?.[0]?.message;
  const argStr = msg?.tool_calls?.[0]?.function?.arguments;
  if (typeof argStr !== 'string') return { title: c.title, status: 'no_arguments' };
  let argumentsObj; try { argumentsObj = JSON.parse(argStr); } catch { return { title: c.title, status: 'arguments_not_json' }; }
  const toon = argumentsObj?.toon;
  if (typeof toon !== 'string' || !toon.trim()) return { title: c.title, status: 'no_toon' };
  const decoded = decodeToon(toon);
  if (!decoded.ok) return { title: c.title, status: 'toon_decode_fail', note: decoded.error };
  const cmd = decoded.value?.command;
  let execRes = undefined;
  if (doExec && typeof cmd === 'string' && cmd.trim()) execRes = safeExec(cmd);
  return { title: c.title, status: 'ok', toon, decoded: decoded.value, exec: execRes };
}

async function main(){
  console.log(`TOON probe → ${url} model=${model} exec=${doExec?'on':'off'}`);
  const results = [];
  for (const c of cases) {
    try {
      const r = await runCase(c);
      results.push(r);
      console.log(`\n=== ${c.title} ===`);
      console.log(`status: ${r.status}`);
      if (r.status === 'ok') {
        const preview = String(r.toon).split('\n').slice(0,4).join('\n');
        console.log('toon:\n' + preview);
        console.log('decoded:', JSON.stringify(r.decoded));
        if (r.exec && r.exec.ok) {
          console.log('exec code:', r.exec.code);
          console.log('stdout:\n' + r.exec.stdout);
          if (r.exec.stderr) console.log('stderr:\n' + r.exec.stderr);
        }
      } else if (r.note) {
        console.log('note:', r.note);
      }
    } catch (e) {
      results.push({ title: c.title, status: 'exception', note: e?.message || String(e) });
      console.log(`\n=== ${c.title} ===`);
      console.log('status: exception');
      console.log('note:', e?.message || String(e));
    }
  }
  const ok = results.filter(x=>x.status==='ok').length;
  console.log('\nSUMMARY:', `${ok}/${results.length} ok`);
  for (const r of results) console.log(`- ${r.title}: ${r.status}`);
}

main().catch(e=>{ console.error('fatal:', e?.message || e); process.exit(1); });
