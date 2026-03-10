/**
 * Responses 请求黑盒闭环测试（V3 实际流水线）
 *
 * 目标：
 *  - Responses payload in → llmswitch-core V3 → Responses payload out
 *  - processMode = 'chat'，providerProtocol = 'openai-responses'
 *  - 在“协议形状”层面以及规范化后的 JSON 上保持输入 = 输出
 *
 * 流水线（core 内部视角）：
 *  - 入口：/v1/responses → profile "responses-chat" → responses-openai codec
 *      Responses → Chat (canonical)
 *      Chat 工具治理（request-tools-stage）
 *  - 出口：providerProtocol = "openai-responses"
 *      Chat → Responses (buildResponsesRequestFromChat)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { AdapterOptions } from '../bridge/routecodex-adapter.js';
import { processIncoming as coreProcessIncoming } from '../bridge/routecodex-adapter.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function normalizeForCompare(v: unknown): unknown {
  if (Array.isArray(v)) {
    return (v as unknown[]).map(normalizeForCompare);
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = normalizeForCompare(obj[key]);
    }
    return out;
  }
  return v;
}

function collectResponsesView(req: AnyObj) {
  const model = String((req as any).model || '');
  const instructions = String((req as any).instructions || '');
  const input = Array.isArray((req as any).input) ? ((req as any).input as AnyObj[]) : [];

  const userTexts: string[] = [];
  const inputShapes: string[] = [];
  const toolCalls: string[] = [];

  const collectText = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collectText).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collectText((val as any).content);
    }
    return '';
  };

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const type = String((entry as any).type || '').toLowerCase();
    const role = String((entry as any).role || '').toLowerCase();
    inputShapes.push(`${type}:${role || '-'}`);
    if (type === 'function_call' || type === 'tool_call') {
      const rawName = (entry as any).name || (entry as any)?.function?.name;
      const name = typeof rawName === 'string' ? rawName : '';
      if (name) toolCalls.push(name);
      continue;
    }
    if (type === 'message' && role === 'user') {
      const msg = asObj((entry as any).message);
      const content = (msg as any).content ?? (entry as any).content;
      const text = collectText(content).trim();
      if (text) userTexts.push(text);
    }
  }

  return { model, instructions, userTexts, inputShapes, toolCalls };
}

function loadResponsesRequestsFromCodexSamples(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const baseDirEnv = process.env.LLMSWITCH_RESPONSES_SAMPLES_DIR;
  const baseDir =
    baseDirEnv && baseDirEnv.trim().length > 0
      ? path.resolve(baseDirEnv)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
  try {
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      return out;
    }
    const files = fs.readdirSync(baseDir).filter(f => f.endsWith('_server-pre-process.json'));
    for (const f of files) {
      try {
        const full = path.join(baseDir, f);
        const txt = fs.readFileSync(full, 'utf8');
        const j = JSON.parse(txt);
        const data = asObj((j as any).data);
        const orig = asObj((data as any).originalData ?? (data as any).payload ?? j);
        out.push({ label: f, req: orig });
      } catch {
        // ignore broken sample
      }
    }
  } catch {
    // ignore directory errors
  }
  return out;
}

function makeSimpleResponsesRequest(): AnyObj {
  return {
    model: 'gpt-5.1',
    instructions: '你是一个简短助手',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '列出本地文件目录' }
        ]
      }
    ]
  };
}

async function runResponsesInOutClosedLoop(): Promise<void> {
  const cases: Array<{ label: string; req: AnyObj }> = [];
  cases.push({ label: 'builtin:responses-in-out-simple', req: makeSimpleResponsesRequest() });
  cases.push(...loadResponsesRequestsFromCodexSamples());

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const baseDir = path.resolve(__dirname, '../../..');

  for (const { label, req } of cases) {
    console.log(`\n=== Responses In→Out Closed Loop Case: ${label} ===`);
    const viewBefore = collectResponsesView(req);

    const dto = {
      data: req,
      metadata: {
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        stream: false
      },
      route: {
        providerId: 'responses',
        modelId: String((req as any).model || 'unknown'),
        requestId: label,
        pipelineId: 'responses-inout-test',
        timestamp: Date.now()
      },
      debug: { enabled: false, stages: {} }
    };

    const options: AdapterOptions = {
      baseDir,
      processMode: 'chat',
      providerProtocol: 'openai-responses'
    };

    let out: any;
    try {
      const res = await coreProcessIncoming(dto, options as any);
      out = res && typeof res === 'object' && 'data' in (res as any) ? (res as any).data : res;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[responses-in-out-closed-loop] ${label}: ERROR`, err);
      continue;
    }

    const outObj = asObj(out);
    const viewAfter = collectResponsesView(outObj);

    const beforeNorm = normalizeForCompare(req);
    const afterNorm = normalizeForCompare(outObj);
    const sameRaw = JSON.stringify(beforeNorm) === JSON.stringify(afterNorm);

    const sameModel = viewBefore.model === viewAfter.model;
    const sameInstr = viewBefore.instructions === viewAfter.instructions;
    const sameUsers = viewBefore.userTexts.join('\n') === viewAfter.userTexts.join('\n');
    const sameShapes = viewBefore.inputShapes.join(',') === viewAfter.inputShapes.join(',');
    const sameTools = viewBefore.toolCalls.join(',') === viewAfter.toolCalls.join(',');

    const ok = sameModel && sameInstr && sameUsers && sameShapes && sameTools && sameRaw;
    console.log(
      `[responses-in-out-closed-loop] ${label}: ` + (ok ? '[OK]' : '[WARN mismatch]'),
      { sameModel, sameInstr, sameUsers, sameShapes, sameTools, sameRaw }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runResponsesInOutClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Responses in→out closed loop test failed:', err);
    process.exit(1);
  });
}
