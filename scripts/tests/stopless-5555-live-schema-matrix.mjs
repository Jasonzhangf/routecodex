#!/usr/bin/env node

import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const baseUrl = process.env.STOPLESS_BASE_URL || 'http://127.0.0.1:5555';
const model = process.env.STOPLESS_MODEL || 'gpt-5.5';
const outputPath = process.env.STOPLESS_OUTPUT || `/tmp/stopless-5555-live-schema-matrix-${Date.now()}.json`;
const routeHint = (process.env.STOPLESS_ROUTE_HINT || 'search').trim();
const attemptsPerScenario = Number.parseInt(process.env.STOPLESS_ATTEMPTS || '3', 10);
const runAllAttempts = /^(1|true|yes)$/i.test(process.env.STOPLESS_RUN_ALL_ATTEMPTS || '');
const maxSubmitRounds = Number.parseInt(process.env.STOPLESS_SUBMIT_ROUNDS || '3', 10);

const runTag = `live-schema-matrix-${Date.now()}`;

const scenarios = [
  {
    id: 'schema_correct',
    expectFirstActivation: true,
    prompt: [
      `RouteCodex 真实 stopless schema_correct live 测试。runTag=${runTag}`,
      '禁止调用工具，禁止解释。',
      '如果当前没有任何 function_call_output 工具结果，只输出 stop schema JSON：{"stopreason":2,"current_goal":"live schema correct reentry","reason":"第一轮继续","next_step":"继续最终核对：只输出 stop schema JSON，{\\"stopreason\\":0,\\"current_goal\\":\\"live schema correct reentry\\",\\"reason\\":\\"已完成 schema correct live reentry\\",\\"has_evidence\\":1,\\"evidence\\":\\"real 5555 submit_tool_outputs accepted\\",\\"issue_cause\\":\\"none\\",\\"excluded_factors\\":\\"not mock\\",\\"diagnostic_order\\":\\"first activation -> real CLI -> submit -> terminal\\",\\"done_steps\\":\\"schema correct activated and reentered\\",\\"next_step\\":\\"\\",\\"next_suggested_path\\":\\"\\",\\"learned\\":\\"live schema correct passed\\"}"}',
      '如果你收到以“继续最终核对”开头的后续提示，只输出其中的 terminal stop schema JSON。'
    ].join('\n')
  },
  {
    id: 'schema_missing',
    expectFirstActivation: true,
    prompt: [
      `RouteCodex 真实 stopless schema_missing live 测试。runTag=${runTag}`,
      '第一轮必须故意缺失 stop schema：不要输出 JSON，不要输出代码块，不要解释，只输出一句中文：我还没有完成，需要继续。',
      '如果你收到后续修复/继续提示，则只输出 terminal stop schema JSON：{"stopreason":0,"current_goal":"live schema missing reentry","reason":"已从缺失 schema 激活后连续重入并修复","has_evidence":1,"evidence":"real 5555 hook CLI output submitted and accepted","issue_cause":"first response intentionally omitted schema","excluded_factors":"not local mock or controlled upstream","diagnostic_order":"missing schema -> exec_command -> real CLI -> submit_tool_outputs -> terminal schema","done_steps":"schema missing activation and reentry verified","next_step":"","next_suggested_path":"","learned":"missing schema live reentry passed"}'
    ].join('\n')
  },
  {
    id: 'schema_invalid',
    expectFirstActivation: true,
    prompt: [
      `RouteCodex 真实 stopless schema_invalid live 测试。runTag=${runTag}`,
      '第一轮必须故意输出错误 schema：不要解释，不要代码块，只输出这个 JSON：{"stopreason":"two","current_goal":123,"next_step":false}',
      '如果你收到后续修复/继续提示，则只输出 terminal stop schema JSON：{"stopreason":0,"current_goal":"live schema invalid reentry","reason":"已从错误 schema 激活后连续重入并修复","has_evidence":1,"evidence":"real 5555 invalid schema feedback submitted and accepted","issue_cause":"first response intentionally used wrong field types","excluded_factors":"not transient local continuation failure","diagnostic_order":"invalid schema -> exec_command -> real CLI -> submit_tool_outputs -> terminal schema","done_steps":"schema invalid activation and reentry verified","next_step":"","next_suggested_path":"","learned":"invalid schema live reentry passed"}'
    ].join('\n')
  }
];

function headers(sessionId) {
  return {
    'content-type': 'application/json',
    ...(routeHint ? { 'x-route-hint': routeHint } : {}),
    'x-session-id': sessionId,
    'x-conversation-id': sessionId
  };
}

async function requestJson(path, body, sessionId) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : headers(sessionId),
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
    httpStatus: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: json,
    raw
  };
}

function responseStatus(body) {
  return body?.status ?? body?.error?.type ?? null;
}

function responseId(body) {
  return body?.id ?? null;
}

function outputText(body) {
  if (typeof body?.output_text === 'string') {
    return body.output_text;
  }
  const out = Array.isArray(body?.output) ? body.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') {
        return part.text;
      }
    }
  }
  return null;
}

function toolCalls(body) {
  const calls = [];
  const required = body?.required_action?.submit_tool_outputs?.tool_calls;
  if (Array.isArray(required)) {
    calls.push(...required);
  }
  const output = body?.output;
  if (Array.isArray(output)) {
    calls.push(...output.filter((item) => item && typeof item === 'object'));
  }
  return calls;
}

function parseArguments(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findExecCommand(body) {
  for (const call of toolCalls(body)) {
    const name = call?.function?.name ?? call?.name;
    if (name !== 'exec_command') {
      continue;
    }
    const args = parseArguments(call?.function?.arguments ?? call?.arguments);
    if (typeof args?.cmd !== 'string') {
      continue;
    }
    return {
      callId: call.call_id ?? call.id ?? call.tool_call_id ?? null,
      cmd: args.cmd
    };
  }
  return null;
}

function runCli(cmd) {
  const result = spawnSync('sh', ['-c', cmd], {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? result.error.message : null
  };
}

function summarizeResponse(res) {
  const exec = findExecCommand(res.body);
  return {
    httpStatus: res.httpStatus,
    responseId: responseId(res.body),
    status: responseStatus(res.body),
    error: res.body?.error ?? null,
    hasExecCommand: Boolean(exec),
    execCallId: exec?.callId ?? null,
    execCommandPrefix: exec?.cmd ? exec.cmd.slice(0, 180) : null,
    outputText: outputText(res.body)
  };
}

async function runScenario(scenario, attempt) {
  const sessionId = `${runTag}-${scenario.id}-${attempt}`;
  const first = await requestJson('/v1/responses', {
    model,
    stream: false,
    metadata: { sessionId, conversationId: sessionId },
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: scenario.prompt }]
      }
    ]
  }, sessionId);
  const firstSummary = summarizeResponse(first);
  const firstExec = findExecCommand(first.body);
  const result = {
    scenario: scenario.id,
    attempt,
    sessionId,
    first: firstSummary,
    cli: null,
    submit: null,
    extraSubmits: [],
    finalExec: null,
    ok: false,
    reason: null
  };

  if (!firstExec) {
    result.reason = 'first_response_did_not_activate_stopless';
    return result;
  }
  if (firstExec.callId !== 'call_stopless_reasoning') {
    result.reason = `unexpected_exec_call_id:${firstExec.callId}`;
    return result;
  }

  const cli = runCli(firstExec.cmd);
  result.cli = {
    status: cli.status,
    signal: cli.signal,
    error: cli.error,
    stderr: cli.stderr.slice(0, 1000),
    stdout: cli.stdout.slice(0, 4000)
  };
  if (cli.error || cli.status !== 0 || !cli.stdout) {
    result.reason = 'real_hook_cli_failed';
    return result;
  }

  const submit = await requestJson('/v1/responses', {
    model,
    stream: false,
    previous_response_id: responseId(first.body),
    metadata: { sessionId, conversationId: sessionId },
    input: [
      {
        type: 'function_call_output',
        call_id: firstExec.callId,
        output: cli.stdout
      }
    ]
  }, sessionId);
  result.submit = summarizeResponse(submit);
  result.finalExec = findExecCommand(submit.body)
    ? {
      callId: findExecCommand(submit.body).callId,
      cmdPrefix: findExecCommand(submit.body).cmd.slice(0, 180)
    }
    : null;

  const submitErrorText = JSON.stringify(submit.body?.error ?? {});
  result.ok = submit.httpStatus === 200
    && Boolean(responseId(first.body))
    && Boolean(responseId(submit.body))
    && responseId(first.body) !== responseId(submit.body)
    && !submitErrorText.includes('local continuation not found')
    && !submitErrorText.includes('local continuation is already committed')
    && ['completed', 'requires_action'].includes(responseStatus(submit.body));
  result.reason = result.ok ? 'live_activation_reentered' : 'submit_did_not_reenter_cleanly';
  if (!result.ok) {
    return result;
  }

  let currentBody = submit.body;
  let currentResponseId = responseId(currentBody);
  let currentExec = findExecCommand(currentBody);
  for (let round = 2; currentExec && round <= maxSubmitRounds; round += 1) {
    if (currentExec.callId !== 'call_stopless_reasoning') {
      result.ok = false;
      result.reason = `unexpected_followup_exec_call_id:${currentExec.callId}`;
      return result;
    }

    const extraCli = runCli(currentExec.cmd);
    const extraRound = {
      round,
      previousResponseId: currentResponseId,
      execCallId: currentExec.callId,
      execCommandPrefix: currentExec.cmd.slice(0, 180),
      cli: {
        status: extraCli.status,
        signal: extraCli.signal,
        error: extraCli.error,
        stderr: (extraCli.stderr || '').slice(0, 1000),
        stdout: (extraCli.stdout || '').trim().slice(0, 4000)
      },
      submit: null,
      ok: false,
      reason: null
    };
    result.extraSubmits.push(extraRound);

    if (extraCli.error || extraCli.status !== 0 || !extraCli.stdout) {
      result.ok = false;
      result.reason = `followup_round_${round}_real_hook_cli_failed`;
      extraRound.reason = result.reason;
      return result;
    }

    const extraSubmit = await requestJson('/v1/responses', {
      model,
      stream: false,
      previous_response_id: currentResponseId,
      metadata: { sessionId, conversationId: sessionId },
      input: [
        {
          type: 'function_call_output',
          call_id: currentExec.callId,
          output: extraCli.stdout
        }
      ]
    }, sessionId);
    extraRound.submit = summarizeResponse(extraSubmit);

    const extraSubmitErrorText = JSON.stringify(extraSubmit.body?.error ?? {});
    extraRound.ok = extraSubmit.httpStatus === 200
      && Boolean(currentResponseId)
      && Boolean(responseId(extraSubmit.body))
      && responseId(extraSubmit.body) !== currentResponseId
      && !extraSubmitErrorText.includes('local continuation not found')
      && !extraSubmitErrorText.includes('local continuation is already committed')
      && ['completed', 'requires_action'].includes(responseStatus(extraSubmit.body));
    extraRound.reason = extraRound.ok ? 'live_activation_reentered' : 'followup_submit_did_not_reenter_cleanly';
    if (!extraRound.ok) {
      result.ok = false;
      result.reason = `followup_round_${round}_submit_did_not_reenter_cleanly`;
      return result;
    }

    currentBody = extraSubmit.body;
    currentResponseId = responseId(currentBody);
    currentExec = findExecCommand(currentBody);
    result.finalExec = currentExec
      ? {
        callId: currentExec.callId,
        cmdPrefix: currentExec.cmd.slice(0, 180)
      }
      : null;
    result.reason = 'live_activation_reentered_continuously';
  }

  if (currentExec) {
    result.reason = `live_activation_reentered_max_rounds_reached:${maxSubmitRounds}`;
  }
  return result;
}

async function main() {
  const report = {
    baseUrl,
    model,
    routeHint,
    runTag,
    outputPath,
    health: await requestJson('/health'),
    scenarios: []
  };

  for (const scenario of scenarios) {
    let accepted = null;
    const attempts = [];
    for (let attempt = 1; attempt <= attemptsPerScenario; attempt += 1) {
      const result = await runScenario(scenario, attempt);
      attempts.push(result);
      if (result.ok) {
        accepted = result;
        if (!runAllAttempts) {
          break;
        }
      }
    }
    report.scenarios.push({
      id: scenario.id,
      ok: runAllAttempts
        ? attempts.length === attemptsPerScenario && attempts.every((attempt) => attempt.ok)
        : Boolean(accepted),
      accepted,
      attempts
    });
  }

  report.ok = report.scenarios.every((scenario) => scenario.ok);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 2;
  }
}

main().catch(async (error) => {
  const failure = {
    baseUrl,
    model,
    routeHint,
    runTag,
    outputPath,
    ok: false,
    error: error instanceof Error ? error.stack || error.message : String(error)
  };
  await fs.writeFile(outputPath, JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure, null, 2));
  process.exit(1);
});
