#!/usr/bin/env tsx
/**
 * Responses Debug Client
 * - Connects to RCC server (baseURL) using OpenAI SDK Responses stream
 * - Consumes SSE named events, prints concise logs
 * - Completes a minimal tool-calls loop by executing local tools and submitting outputs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import OpenAI from 'openai';

type Unknown = Record<string, any>;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      const key = k.replace(/^--/, '');
      if (typeof v === 'string' && v.length) out[key] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[key] = argv[++i]; }
      else out[key] = true;
    }
  }
  return out;
}

function short(s: string, n = 60): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function nowIso(): string { return new Date().toISOString(); }

async function readJson(file: string): Promise<Unknown> {
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const raw = await fs.readFile(abs, 'utf-8');
  return JSON.parse(raw) as Unknown;
}

type ToolOutput = { tool_call_id: string; output: string };

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

// Minimal local tool handlers
const localTools: Record<string, (args: any) => Promise<string> | string> = {
  echo: (args: any) => {
    if (typeof args?.text === 'string') return String(args.text);
    return typeof args === 'string' ? args : JSON.stringify(args ?? {});
  },
  sum: (args: any) => {
    const arr = Array.isArray(args?.numbers) ? args.numbers : [];
    const total = arr.reduce((a: number, b: any) => a + (typeof b === 'number' ? b : 0), 0);
    return String(total);
  },
  time: () => new Date().toISOString(),
};

async function executeTool(name: string, argStr: string): Promise<string> {
  const n = String(name || '').trim();
  const handler = localTools[n] || (async () => `Unsupported tool: ${n}`);
  const args = typeof argStr === 'string' ? safeJsonParse(argStr) : argStr;
  try { return await handler(args); } catch (e: any) { return `Tool error: ${e?.message || String(e)}`; }
}

async function main() {
  const args = parseArgs(process.argv);
  const file = String(args.file || args.f || '');
  if (!file) {
    console.error('Usage: tsx tools/responses-debug-client/src/index.ts --file <payload.json> [--baseURL URL] [--apiKey KEY] [--timeout 120] [--raw] [--save] [--maxRounds 3]');
    process.exit(1);
  }
  const baseURL = String(args.baseURL || 'http://127.0.0.1:5520/v1');
  const apiKey = String(args.apiKey || 'dummy');
  const timeoutSec = Number(args.timeout || 120);
  const raw = !!args.raw;
  const save = !!args.save;
  const maxRounds = Math.max(1, Number(args.maxRounds || 3));

  const reqBody = await readJson(file);
  if (reqBody.stream == null) reqBody.stream = true;

  const client = new OpenAI({ apiKey, baseURL });
  const start = Date.now();
  console.log(`[${nowIso()}] connect baseURL=${baseURL}`);

  const stream: any = await client.responses.stream(reqBody as any);
  let responseId = '';
  let model = '';
  let round = 1;
  const textBuf: string[] = [];

  // tool state
  const toolArgs: Record<string, string> = {};
  const toolMeta: Record<string, { name?: string; output_index?: number; type?: string }> = {};
  let sawRequiredAction = false;
  let submittedThisRound = false;
  const seqCheck = { last: -1 };

  const writeLine = async (o: any) => {
    if (!save) return;
    try {
      const dir = path.resolve(process.cwd(), 'logs', 'responses-debug', responseId || 'unknown');
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: Date.now(), ...o }) + '\n', 'utf-8');
    } catch { /* ignore */ }
  };

  const submitToolOutputs = async (requiredAction: any) => {
    const tc = Array.isArray(requiredAction?.submit_tool_outputs?.tool_calls)
      ? requiredAction.submit_tool_outputs.tool_calls : [];
    const outputs: ToolOutput[] = [];
    for (const call of tc) {
      const id = String(call?.id || '');
      const name = String(call?.function?.name || '');
      const argStr = String(call?.function?.arguments || '');
      const out = await executeTool(name, argStr);
      outputs.push({ tool_call_id: id, output: out });
      console.log(` ↳ tool[${name}] id=${id} -> output(${out.length})`);
    }
    if (typeof stream.submitToolOutputs === 'function') {
      console.log(` -> submitToolOutputs(${outputs.length}) via stream`);
      await stream.submitToolOutputs({ tool_outputs: outputs, stream: true });
      return;
    }
    throw new Error('SDK stream.submitToolOutputs unavailable; please upgrade openai package');
  };

  const dumpEvent = (ev: any) => {
    const t = ev?.type || 'event';
    const d = ev?.data ?? ev;
    const seq = typeof d?.sequence_number === 'number' ? d.sequence_number : undefined;
    if (typeof seq === 'number') {
      if (seq <= seqCheck.last) console.warn(` ! sequence rollback: ${seqCheck.last} -> ${seq}`);
      seqCheck.last = seq;
    }
    if (raw) console.log('evt', t, JSON.stringify(d));
  };

  for await (const ev of stream) {
    await writeLine({ type: ev?.type || 'event', data: ev });
    dumpEvent(ev);

    switch (ev?.type) {
      case 'response.created': {
        responseId = String(ev?.data?.response?.id || responseId);
        model = String(ev?.data?.response?.model || model);
        console.log(`created id=${responseId} model=${model}`);
        break;
      }
      case 'response.in_progress': {
        break;
      }
      case 'response.output_text.delta': {
        const s = String(ev?.data?.delta || '');
        textBuf.push(s);
        console.log(` textΔ(${s.length}): ${short(s)}`);
        break;
      }
      case 'response.output_text.done': {
        console.log(` text✓ (total=${textBuf.join('').length})`);
        break;
      }
      case 'response.output_item.added': {
        const item = ev?.data?.item || {};
        const id = String(item?.id || '');
        toolMeta[id] = { name: item?.name, output_index: ev?.data?.output_index, type: item?.type };
        toolArgs[id] = toolArgs[id] || '';
        console.log(` tool+ id=${id} name=${item?.name || ''}`);
        break;
      }
      case 'response.function_call_arguments.delta': {
        const id = String(ev?.data?.id || ev?.data?.item_id || '');
        const d = String(ev?.data?.delta || '');
        toolArgs[id] = (toolArgs[id] || '') + d;
        console.log(` argsΔ id=${id} (+${d.length})`);
        break;
      }
      case 'response.function_call_arguments.done': {
        const id = String(ev?.data?.id || ev?.data?.item_id || '');
        const total = (toolArgs[id] || '').length;
        console.log(` args✓ id=${id} (${total})`);
        break;
      }
      case 'response.output_item.done': {
        const item = ev?.data?.item || {};
        const id = String(item?.id || '');
        console.log(` tool✓ id=${id}`);
        // Fallback path for providers不发 required_action：在 function_call 完成后立即提交工具输出
        if (!sawRequiredAction && !submittedThisRound && (toolMeta[id]?.type === 'function_call')) {
          const name = toolMeta[id]?.name || item?.name || '';
          const argStr = item?.arguments || toolArgs[id] || '';
          const outputs: ToolOutput[] = [{ tool_call_id: id, output: await executeTool(name, String(argStr)) }];
          if (typeof stream.submitToolOutputs === 'function') {
            console.log(` -> submitToolOutputs(fallback, ${outputs.length}) via stream [round ${round}]`);
            await stream.submitToolOutputs({ tool_outputs: outputs, stream: true });
            submittedThisRound = true;
            round++;
            if (round > maxRounds) throw new Error(`Exceeded maxRounds=${maxRounds}`);
          }
        }
        break;
      }
      case 'response.required_action': {
        const ra = ev?.data?.required_action || ev?.data; // SDK shape varies
        const count = Array.isArray(ra?.submit_tool_outputs?.tool_calls) ? ra.submit_tool_outputs.tool_calls.length : 0;
        console.log(` required_action submit_tool_outputs(${count}) [round ${round}]`);
        sawRequiredAction = true;
        await submitToolOutputs(ra);
        round++;
        if (round > maxRounds) throw new Error(`Exceeded maxRounds=${maxRounds}`);
        break;
      }
      case 'response.completed': {
        const u = ev?.data?.response?.usage || {};
        const iu = Number(u?.input_tokens || 0);
        const ou = Number(u?.output_tokens || 0);
        const tt = Number(u?.total_tokens || 0);
        console.log(` completed usage: in=${iu} out=${ou} total=${tt}`);
        // Reset per-round flags to allow下一轮
        submittedThisRound = false;
        sawRequiredAction = false;
        break;
      }
      case 'response.error': {
        console.error(' error:', ev?.data?.error);
        process.exitCode = 2;
        break;
      }
      case 'response.done': {
        const ms = Date.now() - start;
        console.log(` done in ${ms} ms`);
        return;
      }
      default: {
        // Heartbeat or unknown event
        const d = ev?.data;
        if (d && typeof d === 'object' && d.type === 'heartbeat') {
          // ignore
        } else if (!raw) {
          // print brief unknowns
          const t = String(ev?.type || 'evt');
          console.log(` ${t}`);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e?.message || String(e));
  process.exit(2);
});
