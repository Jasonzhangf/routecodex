#!/usr/bin/env node

/**
 * glm /v1/responses 兼容层 + 工具治理验证：
 *  - 输入：glm-4.7 的 chat.completion 响应，工具调用以自定义 <tool_call> 文本形式埋在 reasoning_content 中。
 *  - 预期：
 *      1) chat:glm compat 被激活，并将文本解析为标准 OpenAI Chat 的 tool_calls + reasoning_content；
 *      2) resp_process_stage1_tool_governance 之后，governedPayload 中仍保留结构化的 exec_command 调用；
 *      3) arguments 可被 JSON 解析，且包含正确的 cmd 字段。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(scriptDir, '..', '..');
const distRootModern = path.join(projectRoot, 'dist');
const distRootLegacy = distRootModern;

function resolveDistModule(...segments) {
  const modern = path.join(distRootModern, ...segments);
  if (fs.existsSync(modern)) return modern;
  return path.join(distRootLegacy, ...segments);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const relFixture = path.join(
    'tests',
    'fixtures',
    'codex-samples',
    'openai-responses',
    'glm-tools_provider-response.json'
  );
  const fixturePath = path.join(projectRoot, relFixture);
  if (!fs.existsSync(fixturePath)) {
    console.warn(`⚠️  [glm-responses-compat] Fixture not found, skip: ${relFixture}`);
    process.exit(0);
  }

  const fixture = readJsonFile(fixturePath);
  const providerPayload = fixture?.body;
  if (!providerPayload || typeof providerPayload !== 'object') {
    throw new Error('[glm-responses-compat] Invalid fixture: missing body payload');
  }

  const [
    sseDecodeMod,
    formatParseMod,
    semanticMapMod,
    compatStageMod,
    mapperMod,
    toolGovernanceMod
  ] = await Promise.all([
    import(
      pathToFileURL(
        resolveDistModule(
          'conversion',
          'hub',
          'pipeline',
          'stages',
          'resp_inbound',
          'resp_inbound_stage1_sse_decode',
          'index.js'
        )
      ).href
    ),
    import(
      pathToFileURL(
        resolveDistModule(
          'conversion',
          'hub',
          'pipeline',
          'stages',
          'resp_inbound',
          'resp_inbound_stage2_format_parse',
          'index.js'
        )
      ).href
    ),
    import(
      pathToFileURL(
        resolveDistModule(
          'conversion',
          'hub',
          'pipeline',
          'stages',
          'resp_inbound',
          'resp_inbound_stage3_semantic_map',
          'index.js'
        )
      ).href
    ),
    import(
      pathToFileURL(
        resolveDistModule(
          'conversion',
          'hub',
          'pipeline',
          'stages',
          'req_outbound',
          'req_outbound_stage3_compat',
          'index.js'
        )
      ).href
    ),
    import(
      pathToFileURL(resolveDistModule('conversion', 'hub', 'response', 'response-mappers.js')).href
    ),
    import(
      pathToFileURL(
        resolveDistModule(
          'conversion',
          'hub',
          'pipeline',
          'stages',
          'resp_process',
          'resp_process_stage1_tool_governance',
          'index.js'
        )
      ).href
    )
  ]);

  const { runRespInboundStage1SseDecode } = sseDecodeMod;
  const { runRespInboundStage2FormatParse } = formatParseMod;
  const { runRespInboundStage3SemanticMap } = semanticMapMod;
  const { runRespInboundStageCompatResponse } = compatStageMod;
  const { OpenAIChatResponseMapper } = mapperMod;
  const { runRespProcessStage1ToolGovernance } = toolGovernanceMod;

  const requestId =
    fixture?.meta?.clientRequestId || 'openai-responses-glm.key1.glm-4.7-glm-4.7-fixture';
  const entryEndpoint = fixture?.meta?.entryEndpoint || '/v1/responses';

  const adapterContext = {
    requestId,
    entryEndpoint,
    providerProtocol: 'openai-chat',
    originalModelId: providerPayload.model ?? 'glm-4.7',
    modelId: providerPayload.model ?? 'glm-4.7',
    compatibilityProfile: 'chat:glm'
  };

  const stage1 = await runRespInboundStage1SseDecode({
    providerProtocol: 'openai-chat',
    payload: providerPayload,
    adapterContext,
    wantsStream: false,
    stageRecorder: undefined
  });

  const formatEnvelope = await runRespInboundStage2FormatParse({
    adapterContext,
    payload: stage1.payload,
    stageRecorder: undefined
  });

  const compatPayload = runRespInboundStageCompatResponse({
    payload: formatEnvelope.payload,
    adapterContext,
    stageRecorder: undefined
  });
  formatEnvelope.payload = compatPayload;

  const mapper = new OpenAIChatResponseMapper();
  const chatResponse = await runRespInboundStage3SemanticMap({
    adapterContext,
    formatEnvelope,
    mapper,
    stageRecorder: undefined
  });

  const { governedPayload } = await runRespProcessStage1ToolGovernance({
    payload: chatResponse,
    entryEndpoint,
    requestId,
    clientProtocol: 'openai-responses',
    stageRecorder: undefined
  });

  const choices = governedPayload?.choices;
  assert.ok(Array.isArray(choices) && choices.length > 0, 'chat choices should exist');

  const message = choices[0]?.message ?? {};
  assert.ok(
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    'GLM tool_calls should be extracted by compat + governance'
  );

  const toolCall = message.tool_calls[0];
  assert.strictEqual(toolCall?.type, 'function', 'tool_call.type should be function');
  assert.strictEqual(
    toolCall?.function?.name,
    'exec_command',
    'tool_call.function.name should be exec_command'
  );

  const argsStr = toolCall?.function?.arguments;
  assert.ok(typeof argsStr === 'string' && argsStr.trim(), 'tool_call arguments should be non-empty string');

  let parsedArgs;
  try {
    parsedArgs = JSON.parse(argsStr);
  } catch (error) {
    throw new Error(
      `[glm-responses-compat] tool_call arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  assert.ok(
    typeof parsedArgs.cmd === 'string' &&
      parsedArgs.cmd.includes('scripts/start-headful.mjs') &&
      parsedArgs.cmd.includes('--profile weibo_fresh'),
    'exec_command.cmd should be preserved and contain start-headful.mjs with weibo_fresh profile'
  );

  console.log('✅ glm responses compat + tool governance fixture passed');
}

main().catch((err) => {
  // 保持与其他测试脚本一致的错误输出格式
  // eslint-disable-next-line no-console
  console.error('❌ glm-responses-compat failed:', err);
  process.exit(1);
});
