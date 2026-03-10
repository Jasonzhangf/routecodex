/**
 * Anthropic Messages 黑盒闭环测试（V3 实际流水线）
 *
 * 目标：
 *  - Anthropic payload in → llmswitch-core V3 → Anthropic payload out
 *  - 不使用 passthrough（processMode = 'chat'）
 *  - 输入 / 输出在“协议形状”层面保持一致（system/messages/tools 等）
 *
 * 流水线（core 内部视角）：
 *  - 入口：/v1/messages → profile "anthropic-chat" → anthropic-openai codec
 *      Anth → Chat (canonical)
 *      Chat 工具治理（request-tools-stage）
 *  - 出口：根据 providerProtocol = "anthropic-messages"
 *      Chat → Anth (buildAnthropicRequestFromOpenAIChat)
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

function collectAnthropicView(req: AnyObj) {
  const model = String((req as any).model || '');

  const systemBlocks = Array.isArray((req as any).system) ? ((req as any).system as AnyObj[]) : [];
  const messages = Array.isArray((req as any).messages) ? ((req as any).messages as AnyObj[]) : [];
  const tools = Array.isArray((req as any).tools) ? ((req as any).tools as AnyObj[]) : [];

  const flattenBlocks = (blocks: AnyObj[]): string => {
    const collect = (val: any): string => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (Array.isArray(val)) return val.map(collect).join('');
      if (typeof val === 'object') {
        if (typeof (val as any).text === 'string') return String((val as any).text);
        if (Array.isArray((val as any).content)) return collect((val as any).content);
      }
      return '';
    };
    return blocks.map(b => collect(b)).join('\n').trim();
  };

  const systemText = flattenBlocks(systemBlocks);

  const msgRoles: string[] = [];
  const msgShapes: string[] = [];

  for (const m of messages) {
    const role = String((m as any).role || '');
    msgRoles.push(role);
    const content = (m as any).content;
    const types: string[] = [];
    if (Array.isArray(content)) {
      for (const b of content as AnyObj[]) {
        const t = String((b as any).type || '').toLowerCase();
        if (t) types.push(t);
      }
    } else if (typeof content === 'string') {
      types.push('text');
    }
    msgShapes.push(`${role}:${types.join('|')}`);
  }

  const toolNames = tools.map(t => String((t as any).name || '')).filter(Boolean);

  return {
    model,
    systemText,
    msgRoles,
    msgShapes,
    toolNames
  };
}

function loadAnthropicRequestsFromCodexSamples(): Array<{ label: string; req: AnyObj }> {
  const out: Array<{ label: string; req: AnyObj }> = [];
  const baseDir =
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR && process.env.LLMSWITCH_ANTH_SAMPLES_DIR.trim().length > 0
      ? path.resolve(process.env.LLMSWITCH_ANTH_SAMPLES_DIR)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');
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
        // ignore one bad sample
      }
    }
  } catch {
    // ignore directory errors
  }
  return out;
}

async function runAnthropicInOutClosedLoop() {
  const cases: Array<{ label: string; req: AnyObj }> = [];

  // 内置简单样本
  const builtin: AnyObj = {
    model: 'chat-model-a',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '列出当前目录下的文件' }]
      }
    ],
    tools: []
  };

  cases.push({ label: 'builtin:anth-in-out-simple', req: builtin });
  cases.push(...loadAnthropicRequestsFromCodexSamples());

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/test → package root
  const baseDir = path.resolve(__dirname, '../../..');

  for (const { label, req } of cases) {
    console.log(`\n=== Anthropic In→Out Closed Loop Case: ${label} ===`);
    const viewBefore = collectAnthropicView(req);

    const dto = {
      data: req,
      metadata: {
        entryEndpoint: '/v1/messages',
        endpoint: '/v1/messages',
        stream: false
      },
      route: {
        providerId: 'anthropic',
        modelId: String((req as any).model || 'unknown'),
        requestId: label,
        pipelineId: 'anthropic-inout-test',
        timestamp: Date.now()
      },
      debug: { enabled: false, stages: {} }
    };

    const options: AdapterOptions = {
      baseDir,
      processMode: 'chat',
      providerProtocol: 'anthropic-messages'
    };

    let out: any;
    try {
      const res = await coreProcessIncoming(dto, options as any);
      out = res && typeof res === 'object' && 'data' in (res as any) ? (res as any).data : res;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[anthropic-in-out-closed-loop] ${label}: ERROR`, err);
      continue;
    }

    const outObj = asObj(out);
    const viewAfter = collectAnthropicView(outObj);

    const beforeNorm = normalizeForCompare(req);
    const afterNorm = normalizeForCompare(outObj);
    const sameRaw = JSON.stringify(beforeNorm) === JSON.stringify(afterNorm);

    const sameModel = viewBefore.model === viewAfter.model;
    const sameSystem = viewBefore.systemText === viewAfter.systemText;
    const sameRoles = viewBefore.msgRoles.join(',') === viewAfter.msgRoles.join(',');
    const sameShapes = viewBefore.msgShapes.join(',') === viewAfter.msgShapes.join(',');
    const sameTools = viewBefore.toolNames.join(',') === viewAfter.toolNames.join(',');

    const ok = sameModel && sameSystem && sameRoles && sameShapes && sameTools && sameRaw;
    console.log(
      `[anthropic-in-out-closed-loop] ${label}: ` +
        (ok ? '[OK]' : '[WARN mismatch]'),
      { sameModel, sameSystem, sameRoles, sameShapes, sameTools, sameRaw }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicInOutClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic in→out closed loop test failed:', err);
    process.exit(1);
  });
}
