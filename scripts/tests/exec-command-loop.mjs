#!/usr/bin/env node
/**
 * exec_command JSON 形态回环验证（模拟 Responses 客户端）。
 *
 * 目标：
 * - 构造一条带 exec_command JSON arguments 的 chat 响应；
 * - 通过 llmswitch-core 的 response 工具过滤管线做统一治理；
 * - 校验最终 JSON 形状（必须包含 cmd，且不暴露 toon）；
 * - 再通过 Responses 映射验证 /v1/responses 视图同样保持 JSON 语义。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const coreLoaderPath = path.join(repoRoot, 'dist', 'modules', 'llmswitch', 'core-loader.js');
const coreLoaderUrl = pathToFileURL(coreLoaderPath).href;

const { importCoreModule } = await import(coreLoaderUrl);

async function main() {
  const { runChatResponseToolFilters } = await importCoreModule('conversion/shared/tool-filter-pipeline');
  const { buildResponsesPayloadFromChat } = await importCoreModule(
    'conversion/responses/responses-openai-bridge'
  );

  // 构造一条模拟的 chat 响应，其中 exec_command 直接使用 JSON 编码参数。
  const chatPayload = {
    id: 'chatcmpl_exec_toon',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.2-codex',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec_toon',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'echo 1',
                  workdir: '.',
                  yield_time_ms: 500,
                  max_output_tokens: 128
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  };

  // 通过 response 工具管线运行，触发 TOON → JSON 解码。
  const filtered = await runChatResponseToolFilters(chatPayload, {
    entryEndpoint: '/v1/chat/completions',
    requestId: 'req_exec_toon',
    profile: 'openai-chat'
  });

  const choice = filtered?.choices?.[0];
  const msg = choice?.message;
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  if (!toolCalls.length) {
    throw new Error('[exec-command-loop] decoded payload missing tool_calls');
  }

  const fn = toolCalls[0]?.function;
  if (!fn || typeof fn !== 'object') {
    throw new Error('[exec-command-loop] first tool_call.function missing');
  }
  if (fn.name !== 'exec_command') {
    throw new Error(`[exec-command-loop] expected exec_command, got ${String(fn.name)}`);
  }
  if (typeof fn.arguments !== 'string' || !fn.arguments.trim()) {
    throw new Error('[exec-command-loop] decoded exec_command.arguments must be non-empty JSON string');
  }

  let args;
  try {
    args = JSON.parse(fn.arguments);
  } catch (error) {
    throw new Error(
      `[exec-command-loop] decoded exec_command arguments not valid JSON: ${
        error instanceof Error ? error.message : String(error ?? 'unknown')
      }`
    );
  }

  if (!args || typeof args !== 'object') {
    throw new Error('[exec-command-loop] decoded exec_command arguments not an object');
  }

  // 与 codex exec_command Responses 工具保持一致：cmd 为必填字段，其它为可选字段。
  if (typeof args.cmd !== 'string' || !args.cmd.trim()) {
    throw new Error('[exec-command-loop] decoded exec_command.args missing cmd');
  }

  const forbiddenKeys = ['toon'];
  for (const key of forbiddenKeys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`[exec-command-loop] decoded exec_command.args must not expose ${key} to client`);
    }
  }

  // 延伸验证：基于 chat 结果构建 Responses payload，确保 /v1/responses 视图中的
  // function_call.arguments 同样保持 exec_command JSON 语义，而不会重新出现 toon。
  const responsesPayload = buildResponsesPayloadFromChat(filtered, {
    requestId: 'verify_exec_command_toon'
  });
  const outputItems = Array.isArray(responsesPayload?.output) ? responsesPayload.output : [];
  const fnCall = outputItems.find(
    (item) => item && item.type === 'function_call' && item.name === 'exec_command'
  );
  if (!fnCall) {
    throw new Error('[exec-command-loop] Responses payload missing exec_command function_call');
  }
  if (typeof fnCall.arguments !== 'string' || !fnCall.arguments.trim()) {
    throw new Error(
      '[exec-command-loop] Responses function_call.arguments must be non-empty JSON string'
    );
  }
  let respArgs;
  try {
    respArgs = JSON.parse(fnCall.arguments);
  } catch (error) {
    throw new Error(
      `[exec-command-loop] Responses function_call.arguments not valid JSON: ${
        error instanceof Error ? error.message : String(error ?? 'unknown')
      }`
    );
  }
  if (!respArgs || typeof respArgs !== 'object') {
    throw new Error('[exec-command-loop] Responses function_call.arguments not an object');
  }
  if (typeof respArgs.cmd !== 'string' || !respArgs.cmd.trim()) {
    throw new Error('[exec-command-loop] Responses exec_command.args missing cmd');
  }
  if (Object.prototype.hasOwnProperty.call(respArgs, 'toon')) {
    throw new Error('[exec-command-loop] Responses exec_command.args must not expose toon');
  }

  console.log(
    `[exec-command-loop] decoded cmd="${args.cmd}" yield_time_ms=${args.yield_time_ms ?? 'n/a'} max_output_tokens=${args.max_output_tokens ?? 'n/a'}`
  );
  console.log('✅ exec_command TOON decode passed (chat + responses views are JSON-only)');
}

main().catch((error) => {
  console.error(
    '[exec-command-loop] FAILED:',
    error instanceof Error ? error.message : String(error ?? 'unknown')
  );
  process.exit(1);
});
