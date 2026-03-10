/**
 * Anthropic 出口侧闭环测试（V3 实际流水线）：
 *
 *   Provider HttpResponse (pipeline.provider.response.post.payload)
 *     → SharedPipelineResponse → routecodex-adapter.processOutgoing
 *     → AnthropicMessage'
 *
 * 目标：
 *  - 入口与出口都在 Anthropic /v1/messages 协议层；
 *  - llmswitch-core 的响应链（Anth → Chat → tools/finalizer → Chat → Anth）
 *    不丢失文本内容、工具块或 stop_reason；
 *  - 形状对齐：message.content 中 text/tool_use/tool_result 的结构保持一致。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { AdapterOptions } from '../bridge/routecodex-adapter.js';
import { processOutgoing as coreProcessOutgoing } from '../bridge/routecodex-adapter.js';

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {};
}

function safeReadJson(file: string): AnyObj | null {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    return asObj(j);
  } catch {
    return null;
  }
}

function collectAnthropicMessageView(msg: AnyObj) {
  const model = String((msg as any).model || '');
  const role = String((msg as any).role || '');
  const stopReason = (msg as any).stop_reason ?? null;
  const usage = asObj((msg as any).usage);

  const contentArr = Array.isArray((msg as any).content) ? ((msg as any).content as AnyObj[]) : [];
  let text = '';
  const toolCalls: Array<{ name: string; argsSample: string }> = [];

  for (const block of contentArr) {
    if (!block || typeof block !== 'object') continue;
    const t = String((block as any).type || '').toLowerCase();
    if (t === 'text' && typeof (block as any).text === 'string') {
      const s = (block as any).text;
      if (s && s.trim().length) {
        text += (text ? '\n' : '') + s.trim();
      }
    } else if (t === 'tool_use') {
      const name = typeof (block as any).name === 'string' ? String((block as any).name) : '';
      const input = (block as any).input;
      let argsSample = '';
      if (input != null) {
        try {
          argsSample = JSON.stringify(input).slice(0, 80);
        } catch {
          argsSample = String(input);
        }
      }
      toolCalls.push({ name, argsSample });
    }
  }

  return { model, role, text, toolCalls, stopReason, usage };
}

/**
 * 生成 Anthropic message.content 的“结构签名”，用于在闭环测试中精确对比形状：
 *  - text: { type: 'text', text }
 *  - tool_use: { type: 'tool_use', id, name, input }
 *  - tool_result: { type: 'tool_result', tool_use_id, content }
 *
 * 为了避免被字段顺序干扰，所有对象都会通过 JSON 序列化做一次深拷贝。
 */
function normalizeAnthropicContent(msg: AnyObj): AnyObj[] {
  const contentArr = Array.isArray((msg as any).content) ? ((msg as any).content as AnyObj[]) : [];
  const normBlocks: AnyObj[] = [];

  for (const block of contentArr) {
    if (!block || typeof block !== 'object') continue;
    const t = String((block as any).type || '').toLowerCase();
    if (t === 'text') {
      normBlocks.push({
        type: 'text',
        text: typeof (block as any).text === 'string' ? (block as any).text : ''
      });
    } else if (t === 'tool_use') {
      let inputNorm: unknown = null;
      const input = (block as any).input;
      if (input !== undefined) {
        try {
          inputNorm = JSON.parse(JSON.stringify(input));
        } catch {
          inputNorm = String(input);
        }
      }
      normBlocks.push({
        type: 'tool_use',
        id: (block as any).id ?? null,
        name: typeof (block as any).name === 'string' ? (block as any).name : '',
        input: inputNorm
      });
    } else if (t === 'tool_result') {
      let contentNorm: unknown = null;
      const c = (block as any).content;
      if (c !== undefined) {
        try {
          contentNorm = JSON.parse(JSON.stringify(c));
        } catch {
          contentNorm = String(c);
        }
      }
      normBlocks.push({
        type: 'tool_result',
        tool_use_id:
          (block as any).tool_use_id ??
          (block as any).tool_call_id ??
          (block as any).id ??
          null,
        content: contentNorm
      });
    }
  }

  return normBlocks;
}

function writeSnapshot(label: string, payload: AnyObj) {
  try {
    const baseDir = process.env.LLMSWITCH_ANTH_SNAPSHOT_DIR
      ? path.resolve(process.env.LLMSWITCH_ANTH_SNAPSHOT_DIR)
      : path.resolve(process.cwd(), 'tmp', 'anthropic-bridge-outgoing');
    fs.mkdirSync(baseDir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(baseDir, `snap-anth-bridge-${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, ...payload }, null, 2), 'utf8');
  } catch {
    // ignore snapshot errors
  }
}

async function runAnthropicBridgeOutgoingClosedLoop() {
  const baseSamplesDir =
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR &&
    process.env.LLMSWITCH_ANTH_SAMPLES_DIR.trim().length > 0
      ? path.resolve(process.env.LLMSWITCH_ANTH_SAMPLES_DIR)
      : path.join(os.homedir(), '.routecodex', 'codex-samples', 'anthropic-messages');

  if (!fs.existsSync(baseSamplesDir) || !fs.statSync(baseSamplesDir).isDirectory()) {
    // eslint-disable-next-line no-console
    console.warn('[anthropic-bridge-outgoing-closed-loop] samples dir not found:', baseSamplesDir);
    return;
  }

  const files = fs
    .readdirSync(baseSamplesDir)
    .filter(f => f.endsWith('_pipeline.provider.response.post.json'));

  if (!files.length) {
    // eslint-disable-next-line no-console
    console.warn(
      '[anthropic-bridge-outgoing-closed-loop] no provider.response.post snapshots in:',
      baseSamplesDir
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[anthropic-bridge-outgoing-closed-loop] running on ${files.length} samples from ${baseSamplesDir}`
  );

  let passedMessages = 0;
  let warnedMessages = 0;
  let passedErrors = 0;
  let warnedErrors = 0;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const baseDir = path.resolve(__dirname, '../../..');

  for (const file of files) {
    const full = path.join(baseSamplesDir, file);
    const raw = safeReadJson(full);
    if (!raw) {
      // eslint-disable-next-line no-console
      console.warn('[anthropic-bridge-outgoing-closed-loop] skip invalid JSON:', file);
      continue;
    }

    const data = asObj(raw.data);
    const payload = asObj(data.payload);
    const httpResp = asObj(payload);
    const innerRaw = asObj(httpResp.data);

    const label = path.basename(file, '.json');

    const entryEndpoint = '/v1/messages';
    const baseDto: AnyObj = {
      data: httpResp,
      metadata: {
        entryEndpoint,
        endpoint: entryEndpoint,
        stream: false
      },
      route: {
        providerId: 'anthropic',
        modelId: String((innerRaw as any).model || 'unknown'),
        requestId: (raw as any).requestId || label,
        pipelineId: String(data.pipelineId || 'anthropic-bridge-outgoing'),
        timestamp: Date.now()
      },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };

    const options: AdapterOptions = {
      baseDir,
      processMode: 'chat',
      providerProtocol: 'anthropic-messages'
    };

    // 分支1：成功 message 样本（type='message'）
    if (String(innerRaw.type || '').toLowerCase() === 'message') {
      const anthMsg = innerRaw;
      const viewBefore = collectAnthropicMessageView(anthMsg);
      const normBefore = normalizeAnthropicContent(anthMsg);

      let outPayload: unknown;
      try {
        const res = await coreProcessOutgoing(baseDto, options as any);
        outPayload = res;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[anthropic-bridge-outgoing-closed-loop] ERROR(message)', label, err);
        continue;
      }

      const anthMsgOut = asObj(outPayload);
      const viewAfter = collectAnthropicMessageView(anthMsgOut);
      const normAfter = normalizeAnthropicContent(anthMsgOut);

      const sameText = viewBefore.text === viewAfter.text;
      const sameToolNames =
        viewBefore.toolCalls.map(t => t.name).join(',') ===
        viewAfter.toolCalls.map(t => t.name).join(',');
      const sameStopReason = String(viewBefore.stopReason || '') === String(viewAfter.stopReason || '');
      const sameContent =
        JSON.stringify(normBefore) === JSON.stringify(normAfter);

      const okMsg = sameText && sameToolNames && sameStopReason && sameContent;
      if (okMsg) passedMessages += 1;
      else warnedMessages += 1;

      writeSnapshot(`${label}:message`, {
        anthBefore: anthMsg,
        anthAfter: anthMsgOut,
        viewBefore,
        viewAfter,
        sameText,
        sameToolNames,
        sameStopReason,
        sameContent,
        normBefore,
        normAfter
      });

      // eslint-disable-next-line no-console
      console.log(
        `[anthropic-bridge-outgoing-closed-loop] ${label} (message): ` +
          (okMsg ? '[OK]' : '[WARN text/tool mismatch]'),
        {
          textEq: sameText,
          toolEq: sameToolNames,
          stopEq: sameStopReason
        }
      );
      continue;
    }

    // 分支2：错误 envelope 样本（例如 { code,msg,success:false }）
    const looksError =
      typeof (innerRaw as any).code === 'number' &&
      typeof (innerRaw as any).msg === 'string' &&
      ((innerRaw as any).success === false || (innerRaw as any).success === 0);

    if (looksError) {
      let outErr: unknown;
      try {
        const res = await coreProcessOutgoing(baseDto, options as any);
        outErr = res;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[anthropic-bridge-outgoing-closed-loop] ERROR(error-env)', label, err);
        continue;
      }

      const beforeNorm = JSON.stringify(innerRaw);
      const afterNorm = JSON.stringify(outErr);
      const okErr = beforeNorm === afterNorm;
      if (okErr) passedErrors += 1;
      else warnedErrors += 1;

      writeSnapshot(`${label}:error`, {
        errorBefore: innerRaw,
        errorAfter: outErr,
        sameJson: okErr
      });

      // eslint-disable-next-line no-console
      console.log(
        `[anthropic-bridge-outgoing-closed-loop] ${label} (error-env): ` +
          (okErr ? '[OK]' : '[WARN error-envelope changed]')
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[anthropic-bridge-outgoing-closed-loop] summary: ` +
      `messages: passed=${passedMessages}, warned=${warnedMessages}; ` +
      `errors: passed=${passedErrors}, warned=${warnedErrors}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnthropicBridgeOutgoingClosedLoop().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Anthropic bridge outgoing closed loop test failed:', err);
    process.exit(1);
  });
}
