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
const routeHint = (process.env.STOPLESS_ROUTE_HINT || 'search').trim();
const maxAttemptsPerModel = Number.parseInt(process.env.STOPLESS_ATTEMPTS || '3', 10);
const outputPath = process.env.STOPLESS_OUTPUT || '/tmp/stopless-5555-live-probe.json';
const probeMode = (process.env.STOPLESS_PROBE_MODE || 'fresh').trim().toLowerCase();
const probeTag = `stopless-live-probe-${Date.now()}`;
const sessionId = `stopless-live-${Date.now()}`;

function buildFirstBody(model) {
  const firstTurnText = [
    `这是 stopless 在线验证。probeTag=${probeTag}`,
    '禁止调用工具，禁止解释。',
    '如果当前没有任何 function_call_output 工具结果，就只输出 stop schema JSON：stopreason=2，reason="第一轮还没做完"，next_step="等待 stop_message_auto 工具结果后继续第二轮验证"。',
    '如果你看到最新 function_call_output 的 output 文本里包含 "\\"repeatCount\\":1"，就只输出 stop schema JSON：stopreason=2，reason="第二轮还没做完"，next_step="基于第二轮工具结果继续最终核对"。',
    '如果你看到最新 function_call_output 的 output 文本里包含 "\\"repeatCount\\":2"，就输出 stop schema JSON：stopreason=0，reason="已完成两轮 stopless 恢复验证"，has_evidence=1，evidence="5555 live submit_tool_outputs"，issue_cause="无"，excluded_factors="已排除一轮即停回归"，diagnostic_order="首轮请求 -> 提交第一次工具输出 -> 提交第二次工具输出"，done_steps="完成首轮 continue、恢复轮次 continue、第二次恢复 allow-stop"，next_step=""，next_suggested_path=""，learned="summary must be markdown"。'
  ].join('\n');

  if (probeMode === 'continuation') {
    return {
      model,
      stream: false,
      metadata: {
        sessionId,
        conversationId: sessionId
      },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `上一轮 stopless 在线验证。probeTag=${probeTag}` }]
        },
        {
          type: 'function_call',
          call_id: 'call_probe_prev_1',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: "routecodex servertool run stop_message_auto --input-json '{\"continuationPrompt\":\"继续 stopless live 验证\",\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"
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
    stream: false,
    metadata: {
      sessionId,
      conversationId: sessionId
    },
    input: [
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
      : { 'content-type': 'application/json', ...extraHeaders },
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
  const toolCalls = responseBody?.required_action?.submit_tool_outputs?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((item) => item && typeof item === 'object');
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
  const parsed = JSON.parse(rawArgs);
  return {
    toolCallId: call.tool_call_id || call.id || null,
    command: typeof parsed?.cmd === 'string' ? parsed.cmd : null
  };
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
    toolCallId: call.tool_call_id || call.id || null,
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

async function runResumeRound(responseId, toolCallId, command) {
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
  const response = await requestJson(
    `${baseUrl}/v1/responses/${encodeURIComponent(responseId)}/submit_tool_outputs`,
    {
      tool_outputs: [
        {
          tool_call_id: toolCallId,
          output: cliOutput
        }
      ]
    }
  );
  return {
    cliOutput,
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
        const resume = await runResumeRound(currentResponseId, currentToolCallId, currentCommand);
        report.resumeChain.push({
          round,
          cliOutput: resume.cliOutput,
          ...resume.summary
        });
        const nextExec = extractExecCommand(resume.response.body);
        currentResponseId = resume.response.body?.id ?? null;
        currentToolCallId = nextExec?.toolCallId ?? null;
        currentCommand = nextExec?.command ?? null;
        if (!nextExec?.command) {
          break;
        }
      }

      report.finalStatus = report.resumeChain.at(-1)?.responseStatus || summary.responseStatus || 'unknown';
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
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
