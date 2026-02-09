import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
const fetch = globalThis.fetch;

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

async function ensureServer(configPath: string, verbose = false): Promise<{ base: string; started: boolean; stop: () => Promise<void> }> {
  const { base } = resolveBaseFromConfig(configPath);
  if (verbose) console.log(`[validate] Checking server at ${base}`);
  const ok = await waitReady(base, 1000);
  if (ok) {
    return { base, started: false, stop: async () => {} };
  }
  // spawn rcc start --config <configPath>
  const { spawn } = await import('child_process');
  const startArgs = ['start', '--config', configPath];
  if (verbose) console.log(`[validate] Spawning: rcc ${startArgs.join(' ')}`);
  const child = spawn('rcc', startArgs, { stdio: 'ignore', detached: false, env: { ...process.env, ROUTECODEX_CONFIG: configPath } });
  const ready = await waitReady(base, 30000);
  if (!ready) {
    try {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    throw new Error('Server not ready after start');
  }
  const stop = async (): Promise<void> => {
    try {
      await fetch(`${base}/shutdown`, { method: 'POST' } as any).catch(() => {});
    } catch {
      // ignore
    }
    try {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return { base, started: true, stop };
}

function samplePayload(endpoint: string, scenario: string, model: string): any {
  const normalizedScenario = scenario?.toLowerCase?.() || '';
  // 仅生成形状示例，具体 model 由调用者在配置中指定（若提供则填入）
  if (endpoint === 'chat' && (normalizedScenario === 'basic' || !normalizedScenario)) {
    return {
      model: model || '',
      messages: [
        { role: 'user', content: '请根据当前配置的模型，测试一个简单的网页抓取场景。' }
      ],
      stream: false
    };
  }
  if (endpoint === 'chat' && normalizedScenario === 'listfiles') {
    return {
      model: model || '',
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
  if (endpoint === 'responses' && (normalizedScenario === 'basic' || !normalizedScenario)) {
    return {
      model: model || '',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '请根据当前配置的模型，测试 Responses 端点。' }] }
      ],
      stream: false
    };
  }
  // default simple text
  return { model: model || '', messages: [{ role: 'user', content: 'ping' }], stream: false };
}

function resolveDefaultModelFromConfig(cfgPath: string, endpoint: string): string {
  const j = readJson(cfgPath) || {};
  try {
    const vr = j?.virtualrouter || {};
    // 1) 优先使用 routing.default 中的第一个目标（例如 lmstudio.gpt-oss-20b-mlx__key1）
    const routes = vr?.routing?.default;
    if (Array.isArray(routes) && routes.length > 0 && typeof routes[0] === 'string') {
      const first = String(routes[0]);
      // pattern: provider.model__key 或 provider.model
      const dot = first.indexOf('.');
      if (dot > 0 && dot < first.length - 1) {
        const rest = first.slice(dot + 1); // model__key 或 model
        const modelId = rest.split('__')[0];
        if (modelId && modelId.trim()) return modelId.trim();
      }
    }
    // 2) 回退到 providers.*.models 中的第一个模型名
    const providers = vr?.providers || {};
    const providerEntries = Object.values(providers) as any[];
    for (const prov of providerEntries) {
      try {
        const models = prov?.models || {};
        const keys = Object.keys(models);
        if (keys.length > 0 && keys[0].trim()) {
          return keys[0].trim();
        }
      } catch { /* ignore per-provider errors */ }
    }
  } catch { /* ignore resolution errors */ }
  // 默认留空，让上游 schema 决定是否报错
  return '';
}

async function sendRequest(base: string, endpoint: string, payload: any, timeoutMs: number): Promise<{ ok: boolean; data: any; status: number; text?: string }>{
  const url = endpoint === 'chat' ? `${base}/v1/chat/completions` : endpoint === 'responses' ? `${base}/v1/responses` : `${base}/v1/messages`;
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' }, body: JSON.stringify(payload), signal: controller.signal } as any);
    clearTimeout(t);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, data: json ?? null, status: res.status, text };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, data: null, status: 0, text: (e as Error)?.message };
  }
}

export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate end-to-end pipeline behavior (auto-start server if needed)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-e, --endpoint <ep>', 'Endpoint: chat|responses|messages', 'chat')
    .option('-s, --scenario <name>', 'Scenario: basic|listfiles', 'basic')
    .option('-p, --payload <file>', 'Custom payload JSON file')
    .option('--timeout <ms>', 'Request timeout in ms', '45000')
    .option('--verbose', 'Verbose logs', false)
    .action(async (opts) => {
      let stopServer: () => Promise<void> = async () => {};
      let started = false;
      let exitCode = 0;
      try {
        const cfg = opts.config || path.join(homedir(), '.routecodex', 'config.json');
        const verbose = !!opts.verbose;
        const { base, started: didStart, stop } = await ensureServer(cfg, verbose);
        if (didStart) {
          started = true;
          stopServer = stop;
        }
        const endpoint = String(opts.endpoint || 'chat');
        const scenario = String(opts.scenario || 'basic');
        const defaultModel = resolveDefaultModelFromConfig(cfg, endpoint);
        const payload = (() => {
          if (opts.payload && fs.existsSync(opts.payload)) {
            const fromFile = readJson(opts.payload) || samplePayload(endpoint, scenario, defaultModel);
            if (!fromFile || typeof fromFile !== 'object') return fromFile;
            if (!fromFile.model && defaultModel) (fromFile as any).model = defaultModel;
            return fromFile;
          }
          return samplePayload(endpoint, scenario, defaultModel);
        })();
        const tmo = Number(opts.timeout || 45000);
        const res = await sendRequest(base, endpoint, payload, tmo);
        if (!res.ok) {
          throw new Error(`[validate] HTTP ${res.status}: ${res.text?.slice(0, 400)}`);
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
            try {
              argsObj = typeof shellCall.function.arguments === 'string'
                ? JSON.parse(shellCall.function.arguments)
                : (shellCall.function.arguments || {});
            } catch {
              argsObj = {};
            }
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
          throw new Error(`[validate] FAILED: ${reason}`);
        }
        console.log('[validate] PASS');
      } catch (e: any) {
        console.error('[validate] ERROR:', e?.message || String(e));
        exitCode = 1;
      } finally {
        if (started) {
          try {
            await stopServer();
          } catch {
            // ignore cleanup failures
          }
        }
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      }
    });
}
