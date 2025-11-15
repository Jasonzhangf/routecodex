import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import fetch from 'node-fetch';

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { method: 'GET' } as any);
      if (r.ok) {
        let j: any = null; try { j = await r.json(); } catch { j = null; }
        const status = j && typeof j === 'object' ? (j as any).status : undefined;
        if (status === 'ok') return true;
      }
    } catch { /* ignore */ }
    await sleep(500);
  }
  return false;
}

function readJson(file: string): any | null {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* ignore */ }
  return null;
}

function resolveBaseFromConfig(cfgPath: string): { host: string; port: number; base: string } {
  const j = readJson(cfgPath) || {};
  const port = Number(j?.httpserver?.port ?? j?.server?.port ?? j?.port ?? 3000);
  const host = String(j?.httpserver?.host || j?.server?.host || j?.host || '127.0.0.1');
  const h = ((): string => {
    const v = host.toLowerCase();
    if (v === '0.0.0.0' || v === '::' || v === '::1' || v === 'localhost') return '127.0.0.1';
    return host;
  })();
  return { host: h, port, base: `http://${h}:${port}` };
}

async function ensureServer(configPath: string, verbose = false): Promise<{ base: string }> {
  const { base } = resolveBaseFromConfig(configPath);
  if (verbose) console.log(`[validate] Checking server at ${base}`);
  const ok = await waitReady(base, 1000);
  if (ok) return { base };
  // spawn rcc start --config <configPath>
  const { spawn } = await import('child_process');
  const startArgs = ['start', '--config', configPath];
  if (verbose) console.log(`[validate] Spawning: rcc ${startArgs.join(' ')}`);
  const child = spawn('rcc', startArgs, { stdio: 'ignore', detached: true, env: { ...process.env, ROUTECODEX_CONFIG: configPath } });
  try { child.unref(); } catch { /* ignore */ }
  const ready = await waitReady(base, 30000);
  if (!ready) throw new Error('Server not ready after start');
  return { base };
}

function samplePayload(endpoint: string, scenario: string): any {
  // 仅生成形状示例，具体 model 由调用者在配置中指定
  if (endpoint === 'chat' && scenario === 'webfetch') {
    return {
      model: '',
      messages: [
        { role: 'user', content: '请根据当前配置的模型，测试一个简单的网页抓取场景。' }
      ],
      stream: false
    };
  }
  if (endpoint === 'chat' && scenario === 'listfiles') {
    return {
      model: '',
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Execute a shell command',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'array', items: { type: 'string' } }
              },
              required: ['command'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: '你可以使用名为 shell 的工具来执行命令。' },
        { role: 'user', content: '请使用 shell 工具列出当前目录文件，执行命令：ls -la。不要输出解释，仅返回结果。' }
      ],
      stream: false
    };
  }
  if (endpoint === 'responses' && scenario === 'webfetch') {
    return {
      model: '',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '请根据当前配置的模型，测试 Responses 端点。' }] }
      ],
      stream: false
    };
  }
  // default simple text
  return { model: '', messages: [{ role: 'user', content: 'ping' }], stream: false };
}

async function sendRequest(base: string, endpoint: string, payload: any, timeoutMs: number): Promise<{ ok: boolean; data: any; status: number; text?: string }>{
  const url = endpoint === 'chat' ? `${base}/v1/chat/completions` : endpoint === 'responses' ? `${base}/v1/responses` : `${base}/v1/messages`;
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' }, body: JSON.stringify(payload), signal: controller.signal } as any);
    clearTimeout(t);
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, data: json ?? null, status: res.status, text };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, data: null, status: 0, text: (e as Error)?.message };
  }
}

function findSnapshotAssertWebFetch(): { ok: boolean; reason?: string } {
  try {
    const root = path.join(homedir(), '.routecodex', 'codex-samples');
    if (!fs.existsSync(root)) return { ok: false, reason: 'no snapshots root' };
    const entries = fs.readdirSync(root).flatMap(dir => {
      const full = path.join(root, dir);
      try { return fs.statSync(full).isDirectory() ? fs.readdirSync(full).map(f => path.join(full, f)) : []; } catch { return []; }
    });
    const candidates = entries.filter(f => /provider\.response\.post\.json$/.test(f));
    candidates.sort((a,b)=> fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of candidates.slice(0, 20)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const s = JSON.stringify(j);
        if (s.includes('"web_fetch"')) return { ok: true };
      } catch { /* ignore */ }
    }
    return { ok: false, reason: 'no recent web_fetch in provider.response.post' };
  } catch { return { ok: false, reason: 'snapshot scan error' }; }
}

export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate end-to-end pipeline behavior (auto-start server if needed)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-e, --endpoint <ep>', 'Endpoint: chat|responses|messages', 'chat')
    .option('-s, --scenario <name>', 'Scenario: webfetch|text', 'webfetch')
    .option('-p, --payload <file>', 'Custom payload JSON file')
    .option('--timeout <ms>', 'Request timeout in ms', '45000')
    .option('--print-snapshots', 'Print snapshot check result', false)
    .option('--verbose', 'Verbose logs', false)
    .action(async (opts) => {
      try {
        const cfg = opts.config || path.join(homedir(), '.routecodex', 'config.json');
        const verbose = !!opts.verbose;
        const { base } = await ensureServer(cfg, verbose);
        const payload = (() => {
          if (opts.payload && fs.existsSync(opts.payload)) return readJson(opts.payload) || samplePayload(opts.endpoint, opts.scenario);
          return samplePayload(opts.endpoint, opts.scenario);
        })();
        const tmo = Number(opts.timeout || 45000);
        const endpoint = String(opts.endpoint || 'chat');
        const scenario = String(opts.scenario || 'webfetch');
        const res = await sendRequest(base, endpoint, payload, tmo);
        if (!res.ok) {
          console.error(`[validate] HTTP ${res.status}: ${res.text?.slice(0, 400)}`);
          process.exit(1);
        }
        // Basic assertions
        let passed = true;
        let reason = '';
        if (endpoint === 'chat') {
          const choices = Array.isArray(res.data?.choices) ? res.data.choices : [];
          const content = choices?.[0]?.message?.content;
          if (!content || String(content).trim().length === 0) { passed = false; reason = 'empty assistant content'; }
        } else if (opts.endpoint === 'responses') {
          const object = res.data?.object;
          const output = Array.isArray(res.data?.output) ? res.data.output : [];
          if (object !== 'response' || output.length === 0) { passed = false; reason = 'responses payload not mapped'; }
        }
        // Special 2-phase tool execution for listfiles scenario on chat endpoint
        if (endpoint === 'chat' && scenario.toLowerCase() === 'listfiles') {
          const choice = Array.isArray(res.data?.choices) ? res.data.choices[0] : null;
          const toolCalls = choice?.message?.tool_calls || [];
          const shellCall = toolCalls.find((tc: any) => (tc?.function?.name || '').toLowerCase() === 'shell');
          if (!shellCall) { passed = false; reason = 'no shell tool_call returned'; }
          else {
            // Parse arguments and execute safe ls
            let argsObj: any = {};
            try { argsObj = typeof shellCall.function.arguments === 'string' ? JSON.parse(shellCall.function.arguments) : (shellCall.function.arguments || {}); } catch {}
            const cmdArr: string[] = Array.isArray(argsObj?.command) ? argsObj.command.map((x: any)=>String(x)) : [];
            const isSafeLs = ((): boolean => {
              if (cmdArr.length === 0) return false;
              const joined = cmdArr.join(' ');
              // allow variants generated by models
              if (/^\s*ls(\s|$)/.test(joined)) return true;
              if (cmdArr[0] === 'bash' && cmdArr[1] === '-lc' && typeof cmdArr[2] === 'string' && /^\s*ls\b/.test(cmdArr[2])) return true;
              return false;
            })();
            let outputText = '';
            if (isSafeLs) {
              const { spawnSync } = await import('child_process');
              const finalCmd = (cmdArr[0] === 'bash' && cmdArr[1] === '-lc') ? cmdArr[2] : cmdArr.join(' ');
              const exec = spawnSync('bash', ['-lc', finalCmd], { encoding: 'utf-8', timeout: 10000 });
              outputText = String(exec.stdout || exec.stderr || '').slice(0, 800);
            } else {
              outputText = 'Command refused by validator: only ls is allowed.';
            }
            // Build second round chat request
            const originalMessages = Array.isArray(payload?.messages) ? payload.messages : [];
            const assistantMsg = { role: 'assistant', content: '', tool_calls: toolCalls } as any;
            const toolMsg = { role: 'tool', tool_call_id: String(shellCall.id || shellCall.call_id || 'call_1'), content: outputText, name: 'shell' } as any;
            const secondBody: any = { model: payload.model, messages: [...originalMessages, assistantMsg, toolMsg], tools: payload.tools, stream: false };
            const res2 = await sendRequest(base, 'chat', secondBody, tmo);
            if (!res2.ok) { passed = false; reason = `second round failed: HTTP ${res2.status}`; }
            else {
              const c2 = Array.isArray(res2.data?.choices) ? res2.data.choices[0] : null;
              const text2 = String(c2?.message?.content || '').trim();
              if (!text2) { passed = false; reason = 'empty assistant content after tool execution'; }
            }
          }
        }
        if (!passed) {
          console.error(`[validate] FAILED: ${reason}`);
          process.exit(1);
        }
        // Snapshot assert web_fetch present (best-effort)
        const snap = findSnapshotAssertWebFetch();
        if (opts.printSnapshots) console.log(`[validate] snapshot check: ${snap.ok ? 'ok' : 'miss'}${snap.reason ? ` (${snap.reason})` : ''}`);
        console.log('[validate] PASS');
      } catch (e: any) {
        console.error('[validate] ERROR:', e?.message || String(e));
        process.exit(1);
      }
    });
}
