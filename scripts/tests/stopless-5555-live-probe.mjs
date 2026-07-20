#!/usr/bin/env node

import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const baseUrl = process.env.STOPLESS_BASE_URL || 'http://127.0.0.1:5555';
const models = String(
  process.env.STOPLESS_MODELS || 'gpt-5.5'
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const routeHint = (process.env.STOPLESS_ROUTE_HINT || 'thinking').trim();
const maxAttemptsPerModel = Number.parseInt(process.env.STOPLESS_ATTEMPTS || '3', 10);
const outputPath = process.env.STOPLESS_OUTPUT || '/tmp/stopless-5555-live-probe.json';
const probeMode = (process.env.STOPLESS_PROBE_MODE || 'fresh').trim().toLowerCase();
const probeTag = `stopless-live-probe-${Date.now()}`;
const sessionId = `stopless-live-${Date.now()}`;
const PROBE_ORIGINAL_TOOL_NAMES = ['exec', 'wait', 'request_user_input'];

function probeAdditionalToolsItem() {
  return {
    type: 'additional_tools',
    role: 'developer',
    tools: [
      {
        type: 'custom',
        name: 'exec',
        description: 'probe original custom tool that must survive stopless injection',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: 'start: SOURCE\nSOURCE: /[\\s\\S]+/'
        }
      },
      {
        type: 'function',
        name: 'wait',
        description: 'probe original wait tool that must survive stopless injection',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { cell_id: { type: 'string' } },
          required: ['cell_id']
        },
        strict: false
      },
      {
        type: 'function',
        name: 'request_user_input',
        description: 'probe original user-input tool that must survive stopless injection',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { questions: { type: 'array' } },
          required: ['questions']
        },
        strict: false
      }
    ]
  };
}

function buildFirstBody(model) {
  const phase1 = `PHASE1_${probeTag}`;
  const phase2 = `PHASE2_${probeTag}`;
  const phase3 = `PHASE3_${probeTag}`;
  const firstSchema = JSON.stringify({
    stopreason: 2,
    current_goal: `验证 V3 stopless 连续两轮恢复 ${probeTag}`,
    reason: '第一轮还没做完',
    has_evidence: 0,
    evidence: '',
    next_step: phase2,
    needs_user_input: false
  });
  const firstTurnText = [
    `这是停止检查在线验证。probeTag=${probeTag}`,
    '禁止调用任何工具，禁止解释，禁止输出 Markdown。',
    '判断规则只看最后一个 user message：',
    `- 如果最后一个 user message 包含 CURRENT_PHASE=${phase1}，只输出这个 JSON：${firstSchema}`,
    `- 如果最后一个 user message 完全等于 ${phase2}，只输出合法 stop schema JSON：stopreason=2, current_goal="验证 V3 stopless 连续两轮恢复 ${probeTag}", reason="第二轮还没做完", has_evidence=0, evidence="", next_step="${phase3}", needs_user_input=false。`,
    `- 如果最后一个 user message 完全等于 ${phase3}，只输出合法 terminal stop schema JSON：stopreason=0, current_goal="验证 V3 stopless 连续两轮恢复 ${probeTag}", reason="已完成两轮停止检查恢复验证", has_evidence=1, evidence="5555 live submit_tool_outputs ${probeTag}", issue_cause="无", excluded_factors="已排除一轮即停回归", diagnostic_order="首轮请求 -> 提交第一次工具输出 -> 提交第二次工具输出", done_steps="完成首轮 continue、恢复轮次 continue、第二次恢复 allow-stop", next_step="", next_suggested_path="", needs_user_input=false, learned="summary must be markdown"。`,
    `CURRENT_PHASE=${phase1}`
  ].join('\n');

  if (probeMode === 'continuation') {
    return {
      model,
      stream: true,
      metadata: {
        sessionId,
        conversationId: sessionId
      },
      input: [
        probeAdditionalToolsItem(),
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `上一轮停止检查在线验证。probeTag=${probeTag}` }]
        },
        {
          type: 'function_call',
          call_id: 'call_probe_prev_1',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "routecodex servertool run stop_message_auto --input-json '{\"continuationPrompt\":\"继续停止检查 live 验证\",\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"
          })
        },
        {
          type: 'function_call_output',
          call_id: 'call_probe_prev_1',
          output: JSON.stringify({ repeatCount: 1, status: 'ok', probeTag })
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: firstTurnText }]
        }
      ]
    };
  }

  return {
    model,
    stream: true,
    metadata: {
      sessionId,
      conversationId: sessionId
    },
    input: [
      probeAdditionalToolsItem(),
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: firstTurnText
          }
        ]
      }
    ]
  };
}

async function requestJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined
      ? Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined
      : {
        'content-type': 'application/json',
        ...(body?.stream === true ? { accept: 'text/event-stream' } : {}),
        ...extraHeaders
      },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: json,
    raw
  };
}

function extractRequiredActionToolCalls(responseBody) {
  const toolCalls = [];
  const requiredActionCalls = responseBody?.required_action?.submit_tool_outputs?.tool_calls;
  if (Array.isArray(requiredActionCalls)) {
    toolCalls.push(...requiredActionCalls.filter((item) => item && typeof item === 'object'));
  }
  const outputCalls = responseBody?.output;
  if (Array.isArray(outputCalls)) {
    toolCalls.push(...outputCalls.filter((item) => (
      item && typeof item === 'object'
      && ['function_call', 'custom_tool_call', 'tool_call'].includes(item.type)
    )));
  }
  return toolCalls;
}

function extractExecCommand(responseBody) {
  const toolCalls = extractRequiredActionToolCalls(responseBody);
  const call = toolCalls.find(
    (item) => item?.name === 'exec_command' || item?.function?.name === 'exec_command'
  );
  if (!call) {
    return null;
  }
  const rawArgs = call?.function?.arguments ?? call?.arguments;
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) {
    return null;
  }
  const parsed = parseExecCommandArguments(rawArgs);
  return {
    toolCallId: call.tool_call_id || call.call_id || call.id || null,
    command: typeof parsed?.cmd === 'string' ? parsed.cmd : null
  };
}

function parseExecCommandArguments(rawArgs) {
  try {
    return JSON.parse(rawArgs);
  } catch {
    const keyIndex = rawArgs.indexOf('"cmd"');
    if (keyIndex < 0) {
      throw new Error(`unable to parse exec_command arguments: ${rawArgs.slice(0, 500)}`);
    }
    const colonIndex = rawArgs.indexOf(':', keyIndex);
    const firstQuoteIndex = rawArgs.indexOf('"', colonIndex + 1);
    if (colonIndex < 0 || firstQuoteIndex < 0) {
      throw new Error(`unable to parse exec_command arguments: ${rawArgs.slice(0, 500)}`);
    }
    let cursor = firstQuoteIndex + 1;
    let escapedMode = false;
    while (cursor < rawArgs.length) {
      const ch = rawArgs[cursor];
      if (escapedMode) {
        escapedMode = false;
        cursor += 1;
        continue;
      }
      if (ch === '\\') {
        escapedMode = true;
        cursor += 1;
        continue;
      }
      if (ch === '"') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= rawArgs.length) {
      throw new Error(`unable to parse exec_command arguments: ${rawArgs.slice(0, 500)}`);
    }
    const escaped = rawArgs.slice(firstQuoteIndex, cursor + 1);
    return {
      cmd: JSON.parse(escaped)
    };
  }
}

function extractReasoningStop(responseBody) {
  const toolCalls = extractRequiredActionToolCalls(responseBody);
  const call = toolCalls.find(
    (item) => item?.name === 'reasoning.stop' || item?.function?.name === 'reasoning.stop'
  );
  if (!call) {
    return null;
  }
  const rawArgs = call?.function?.arguments ?? call?.arguments;
  return {
    toolCallId: call.tool_call_id || call.call_id || call.id || null,
    arguments: typeof rawArgs === 'string' ? rawArgs : null
  };
}

export function parseSseResponseEnvelope(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  let latestResponse = null;
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) {
      continue;
    }
    const payloadText = trimmed.slice(6);
    if (!payloadText || payloadText === '{"type":"ping"}') {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      continue;
    }
    const response = payload?.response;
    if (response && typeof response === 'object') {
      latestResponse = response;
    }
  }
  return latestResponse;
}

export function materializeProbeResponseBody(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return responseBody;
  }
  if (typeof responseBody.raw !== 'string') {
    return responseBody;
  }
  const parsed = parseSseResponseEnvelope(responseBody.raw);
  if (!parsed) {
    return responseBody;
  }
  return {
    ...responseBody,
    ...parsed
  };
}

export function summarizeAttempt(model, attempt, response) {
  const materializedBody = materializeProbeResponseBody(response.body);
  const execCommand = extractExecCommand(materializedBody);
  const reasoningStop = extractReasoningStop(materializedBody);
  const outputText = typeof materializedBody?.output_text === 'string'
    ? materializedBody.output_text
    : extractOutputText(materializedBody);
  const execCommandText = execCommand?.command ?? null;
  return {
    model,
    attempt,
    status: response.status,
    responseId: materializedBody?.id ?? null,
    requestId: materializedBody?.request_id ?? materializedBody?.error?.request_id ?? null,
    responseStatus: materializedBody?.status ?? null,
    errorCode: materializedBody?.error?.code ?? null,
    errorMessage: materializedBody?.error?.message ?? null,
    hasExecCommand: Boolean(execCommandText),
    hasReasoningStop: Boolean(reasoningStop?.toolCallId),
    isStopMessageAutoExecCommand: isStopMessageAutoCommand(execCommandText),
    toolCallId: execCommand?.toolCallId ?? null,
    execCommand: execCommandText,
    reasoningStopToolCallId: reasoningStop?.toolCallId ?? null,
    reasoningStopArguments: reasoningStop?.arguments ?? null,
    outputText,
    leakedStopSchema: looksLikeStopSchema(outputText),
    rawBody: response.body ?? null
  };
}

function extractOutputText(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return null;
  }
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text;
      }
    }
  }
  return null;
}

function looksLikeStopSchema(text) {
  if (typeof text !== 'string') {
    return false;
  }
  return /"stopreason"\s*:/.test(text) || /"needs_user_input"\s*:/.test(text);
}

function isStopMessageAutoCommand(command) {
  return typeof command === 'string' && (
    command.includes('routecodex hook run reasoningStop')
    || command.includes('routecodex hook run reasoning_stop')
    || command.includes('routecodex servertool run stop_message_auto')
  );
}

function expectedProviderPromptFromCliOutput(cliOutput) {
  if (typeof cliOutput !== 'string' || !cliOutput.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(cliOutput);
    return readFirstString(
      parsed,
      ['continuationPrompt', 'continuation_prompt', 'next_step', 'nextStep', 'followupText']
    );
  } catch {
    return null;
  }
}

function readFirstString(value, keys) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  const input = value.input;
  if (input && typeof input === 'object') {
    return readFirstString(input, keys);
  }
  return null;
}

function summarizeProviderDryRun(response, expectedPrompt) {
  const dryBody = response.body && typeof response.body === 'object' ? response.body : {};
  const providerBody = dryBody?.providerRequest?.body
    ?? dryBody?.dry_run?.provider_request?.body
    ?? null;
  const input = Array.isArray(providerBody?.input) ? providerBody.input : [];
  const conversationItems = extractProviderConversationItems(providerBody);
  const lastUser = extractLastProviderUserText(conversationItems);
  const toolNames = collectProviderToolNames(providerBody);
  const additionalToolsInputCount = input.filter((item) => item?.type === 'additional_tools').length;
  const topLevelToolCount = Array.isArray(providerBody?.tools) ? providerBody.tools.length : 0;
  const providerHasResponsesInput = Array.isArray(providerBody?.input);
  const providerHasChatMessages = Array.isArray(providerBody?.messages);
  const originalToolNamesPreserved = PROBE_ORIGINAL_TOOL_NAMES
    .every((name) => toolNames.includes(name));
  const noSiblingToolSurfaceForAdditionalTools = providerHasResponsesInput
    ? (additionalToolsInputCount === 0 || topLevelToolCount === 0)
    : true;
  const structuredStoplessLeaks = collectStructuredStoplessLeaks(providerBody);
  const structuredControlLeaks = collectStructuredControlLeaks(providerBody);
  const guidanceText = extractProviderGuidanceText(providerBody);
  const guidance = typeof guidanceText === 'string'
    && [
      'reasoningStop',
      '<rcc_stop_schema>',
      'stopreason',
      'has_evidence',
      'evidence',
      'current_goal',
      'next_step',
      'needs_user_input'
    ].every((token) => guidanceText.includes(token));
  const stoppedBeforeProviderSend = dryBody?.stoppedBeforeProviderSend === true
    || dryBody?.dry_run?.stopped_before_provider_send === true
    || dryBody?.dry_run?.provider_network_send === false;
  const objectOk = dryBody?.object === 'routecodex.pipeline_dry_run'
    || dryBody?.dryRun === true
    || dryBody?.dry_run?.fixture_id === 'responses_relay_provider_request';
  const lastUserMatchesExpected = expectedPrompt == null || lastUser === expectedPrompt;
  const reasoningStopCount = toolNames.filter((name) => name === 'reasoningStop').length;
  const providerShapeOk = providerHasResponsesInput
    ? additionalToolsInputCount === 1
    : providerHasChatMessages;
  return {
    status: response.status,
    object: dryBody?.object ?? null,
    dryRunFixture: dryBody?.dry_run?.fixture_id ?? null,
    stoppedBeforeProviderSend,
    providerBodyPresent: Boolean(providerBody),
    inputLen: input.length,
    conversationLen: conversationItems.length,
    providerShape: providerHasResponsesInput
      ? 'responses'
      : providerHasChatMessages
        ? 'openai_chat'
        : 'unknown',
    toolNames,
    additionalToolsInputCount,
    topLevelToolCount,
    expectedOriginalToolNames: PROBE_ORIGINAL_TOOL_NAMES,
    originalToolNamesPreserved,
    noSiblingToolSurfaceForAdditionalTools,
    reasoningStopCount,
    guidance,
    expectedPrompt,
    lastUser,
    lastUserMatchesExpected,
    structuredStoplessLeaks,
    structuredControlLeaks,
    ok: response.status === 200
      && objectOk
      && stoppedBeforeProviderSend
      && Boolean(providerBody)
      && reasoningStopCount === 1
      && providerShapeOk
      && originalToolNamesPreserved
      && noSiblingToolSurfaceForAdditionalTools
      && guidance
      && lastUserMatchesExpected
      && structuredStoplessLeaks.length === 0
      && structuredControlLeaks.length === 0
  };
}

function extractProviderConversationItems(providerBody) {
  if (Array.isArray(providerBody?.input)) {
    return providerBody.input;
  }
  if (Array.isArray(providerBody?.messages)) {
    return providerBody.messages;
  }
  return [];
}

function extractProviderGuidanceText(providerBody) {
  const chunks = [];
  if (typeof providerBody?.instructions === 'string') {
    chunks.push(providerBody.instructions);
  }
  const messages = Array.isArray(providerBody?.messages) ? providerBody.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    if (message.role !== 'system' && message.role !== 'developer') {
      continue;
    }
    const content = normalizeProviderUserContent(message.content);
    if (typeof content === 'string' && content.trim()) {
      chunks.push(content);
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : null;
}

function collectProviderToolNames(providerBody) {
  const names = [];
  const pushToolNames = (tools) => {
    if (!Array.isArray(tools)) {
      return;
    }
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') {
        continue;
      }
      const name = typeof tool.name === 'string'
        ? tool.name
        : typeof tool.function?.name === 'string'
          ? tool.function.name
          : null;
      if (name) {
        names.push(name);
      }
    }
  };
  pushToolNames(providerBody?.tools);
  const input = Array.isArray(providerBody?.input) ? providerBody.input : [];
  for (const item of input) {
    if (item?.type === 'additional_tools') {
      pushToolNames(item.tools);
    }
  }
  return names;
}

function extractLastProviderUserText(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.role !== 'user') {
      continue;
    }
    return normalizeProviderUserContent(item.content);
  }
  return null;
}

function normalizeProviderUserContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content?.text === 'string') {
    return content.text;
  }
  return content == null ? null : String(content);
}

function collectStructuredStoplessLeaks(value) {
  const leaks = [];
  walkJson(value, 'providerBody', (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    if (node.name === 'call_stopless_reasoning' || node.call_id === 'call_stopless_reasoning') {
      leaks.push(path);
    }
  });
  return leaks;
}

function collectStructuredControlLeaks(value) {
  const forbidden = new Set([
    'repeatCount',
    'maxRepeats',
    'triggerHint',
    'schemaFeedback',
    'reasonCode',
    'missingFields'
  ]);
  const leaks = [];
  walkJson(value, 'providerBody', (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    for (const key of Object.keys(node)) {
      if (forbidden.has(key)) {
        leaks.push(`${path}.${key}`);
      }
    }
  });
  return leaks;
}

function walkJson(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, `${path}[${index}]`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walkJson(child, `${path}.${key}`, visit);
    }
  }
}

async function runResumeRound(model, responseId, toolCallId, command) {
  const cliRun = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  });
  if (cliRun.error) {
    const detail = [
      cliRun.error.message,
      cliRun.stdout ? `stdout=${cliRun.stdout.slice(0, 800)}` : '',
      cliRun.stderr ? `stderr=${cliRun.stderr.slice(0, 800)}` : ''
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  }
  if ((cliRun.status ?? 0) !== 0) {
    const detail = [
      `cli exited with status=${cliRun.status ?? 'unknown'}`,
      cliRun.stdout ? `stdout=${cliRun.stdout.slice(0, 800)}` : '',
      cliRun.stderr ? `stderr=${cliRun.stderr.slice(0, 800)}` : ''
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  }
  const cliOutput = (cliRun.stdout ?? '').trim();
  const submitBody = {
    model,
    stream: true,
    previous_response_id: responseId,
    metadata: {
      sessionId,
      conversationId: sessionId
    },
    input: [
      {
        type: 'function_call_output',
        call_id: toolCallId,
        output: cliOutput
      }
    ]
  };
  const expectedPrompt = expectedProviderPromptFromCliOutput(cliOutput);
  const providerDryRun = await requestJson(
    `${baseUrl}/v1/responses`,
    submitBody,
    {
      ...(routeHint ? { 'x-route-hint': routeHint } : {}),
      'x-session-id': sessionId,
      'x-conversation-id': sessionId,
      'x-routecodex-dry-run': 'provider-request',
      accept: 'application/json'
    }
  );
  const response = await requestJson(
    `${baseUrl}/v1/responses`,
    submitBody,
    {
      ...(routeHint ? { 'x-route-hint': routeHint } : {}),
      'x-session-id': sessionId,
      'x-conversation-id': sessionId
    }
  );
  return {
    cliOutput,
    providerDryRun: summarizeProviderDryRun(providerDryRun, expectedPrompt),
    response,
    summary: summarizeAttempt('submit_tool_outputs', 0, response)
  };
}

async function main() {
  const report = {
    baseUrl,
    models,
    sessionId,
    maxAttemptsPerModel,
    probeMode,
    probeTag,
    note: [
      'This probe only accepts live stopless evidence from managed non-direct routes.',
      'Default model is gpt-5.5 because earlier verified 5555 live stopless samples entered managed search through router-gpt-5.5, while explicit MiniMax/mimo model probes later regressed into direct/thinking invalid paths.',
      routeHint ? `Route hint is forced to ${routeHint}.` : 'No explicit route hint.',
      'Current live success contract accepts either stopless exec_command CLI projection or proactive required_action.reasoning.stop tool call.',
      'If a response completes with leaked stop schema text and no structured tool call, treat it as a direct/no-stopless invalid entry rather than a passed stopless run.'
    ],
    routeHint: routeHint || null,
    health: null,
    attempts: [],
    chosenModel: null,
    providerDryRuns: [],
    resumeChain: [],
    finalStatus: 'unverified'
  };

  report.health = await requestJson(`${baseUrl}/health`, undefined);

  for (const model of models) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      const response = await requestJson(
        `${baseUrl}/v1/responses`,
        buildFirstBody(model),
        {
          ...(routeHint ? { 'x-route-hint': routeHint } : {}),
          'x-session-id': sessionId,
          'x-conversation-id': sessionId
        }
      );
      const summary = summarizeAttempt(model, attempt, response);
      report.attempts.push(summary);
      if (summary.leakedStopSchema && !summary.hasExecCommand && summary.responseStatus === 'completed') {
        report.finalStatus = 'invalid_direct_or_no_stopless_path';
      }
      if (summary.errorCode === 'PROVIDER_NOT_AVAILABLE') {
        report.finalStatus = 'provider_not_available_or_session_backoff';
      }
      if (summary.hasExecCommand && !summary.isStopMessageAutoExecCommand) {
        report.finalStatus = 'invalid_non_stopless_exec_command_path';
        continue;
      }
      if (summary.hasReasoningStop && !summary.hasExecCommand) {
        report.chosenModel = model;
        report.finalStatus = 'reasoning_stop_requires_action';
        await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (!summary.hasExecCommand) {
        continue;
      }

      report.chosenModel = model;
      let currentResponseId = summary.responseId;
      let currentToolCallId = summary.toolCallId;
      let currentCommand = summary.execCommand;

      for (let round = 1; round <= 2; round += 1) {
        if (!currentResponseId || !currentToolCallId || !currentCommand) {
          break;
        }
        const resume = await runResumeRound(model, currentResponseId, currentToolCallId, currentCommand);
        report.providerDryRuns.push({
          round,
          ...resume.providerDryRun
        });
        report.resumeChain.push({
          round,
          cliOutput: resume.cliOutput,
          ...resume.summary
        });
        const materializedResumeBody = materializeProbeResponseBody(resume.response.body);
        const nextExec = extractExecCommand(materializedResumeBody);
        currentResponseId = materializedResumeBody?.id ?? null;
        currentToolCallId = nextExec?.toolCallId ?? null;
        currentCommand = nextExec?.command ?? null;
        if (!nextExec?.command) {
          break;
        }
      }

      const firstResume = report.resumeChain[0];
      const finalResume = report.resumeChain.at(-1);
      const providerDryRunsOk = report.providerDryRuns.length === 2
        && report.providerDryRuns.every((dryRun) => dryRun.ok === true);
      const completedTwoRoundLoop = report.resumeChain.length === 2
        && providerDryRunsOk
        && firstResume?.hasExecCommand === true
        && firstResume?.isStopMessageAutoExecCommand === true
        && finalResume?.responseStatus === 'completed'
        && finalResume?.leakedStopSchema !== true
        && !finalResume?.errorCode;
      report.finalStatus = completedTwoRoundLoop
        ? 'completed'
        : 'invalid_stopless_continuation_loop';
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      if (!completedTwoRoundLoop) {
        process.exitCode = 3;
      }
      return;
    }
  }

  if (report.finalStatus === 'unverified') {
    report.finalStatus = 'no_live_stopless_path';
  }
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.finalStatus === 'no_live_stopless_path' ? 2 : 3;
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (typeof entryPath !== 'string' || !entryPath) {
    return false;
  }
  return pathToFileURL(entryPath).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch(async (error) => {
    const failure = {
      baseUrl,
      models,
      maxAttemptsPerModel,
      finalStatus: 'probe_error',
      error: error instanceof Error ? error.message : String(error)
    };
    await fs.writeFile(outputPath, JSON.stringify(failure, null, 2));
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  });
}
