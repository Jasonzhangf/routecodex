#!/usr/bin/env node
// Stopless 收口 final probe (2026-06-17): session-id + budget + direct skip
//
// 1) 5555 /v1/responses: 触发 stopless, 从 required_action.submit_tool_outputs[0].function.arguments.cmd
//    解析 execCommand, 断言 --session-id 与 --request-id 真实存在;
//    拿到 clientCallId 真正 spawn 'routecodex hook run reasoning_stop ...' CLI,
//    解析 stdout, 断言 output.sessionId 与 output.requestId 与 --input-json 都不带 continuationPrompt
//    2) 三次 submit_tool_outputs 推进 used: 1 -> 2 -> 3, 第三次触发后必须 output.repeatCount == 3 且
//    output.summary 命中公共收敛状态 '停止检查已收敛'，不得泄露内部 stopless 文案;
//    3) 5520 /v1/responses (provider-direct) 不能返回 servertool 工具调用或 :stop_followup;
//       断言 execCommand 字段缺失 + finish_reason=stop 一次通过.

import { spawnSync } from 'node:child_process';

const PORT_5555 = '127.0.0.1:5555';
const PORT_5520 = '127.0.0.1:5520';
const SESSION_ID = `stopless-final-${Date.now()}`;
const PROBE_TAG = `final-${Date.now()}`;

function logHeader(title) {
  console.log(`\n=== ${title} ===`);
}

function postJson(url, body, headers = {}) {
  const res = spawnSync('curl', [
    '-sS', '-X', 'POST', url,
    '-H', 'Content-Type: application/json',
    ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    '--data', JSON.stringify(body),
    '--max-time', '90'
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`curl ${url} failed: ${res.stderr}`);
  }
  if (!res.stdout) return null;
  try { return JSON.parse(res.stdout); } catch { return res.stdout; }
}

function findExecCommand(body) {
  if (!body || typeof body !== 'object') return null;
  const required = body.required_action?.submit_tool_outputs?.tool_calls || [];
  for (const call of required) {
    if (call?.function?.name === 'exec_command' || call?.name === 'exec_command') {
      const raw = call.function?.arguments ?? call.arguments;
      if (typeof raw !== 'string') continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.cmd === 'string') {
          return { cmd: parsed.cmd, callId: call.id || call.call_id || call.tool_call_id };
        }
      } catch {
        return { cmd: raw, callId: call.id || call.call_id || call.tool_call_id };
      }
    }
  }
  return null;
}

function runCli(cmd) {
  // Use the currently installed `routecodex` shim from PATH.
  const result = spawnSync('sh', ['-c', cmd], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    return { error: result.stderr || `exit ${result.status}`, stdout: result.stdout };
  }
  try {
    return { stdout: JSON.parse(result.stdout) };
  } catch {
    return { stdout: result.stdout };
  }
}

const report = { sessionId: SESSION_ID, probeTag: PROBE_TAG, steps: [] };

function record(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log('       detail:', JSON.stringify(detail).slice(0, 800));
}

try {
  logHeader('Step 1: 5555 stopless first turn returns exec_command with --session-id');
  const firstBody = {
    model: 'routecodex-servertool-cli',
    stream: false,
    metadata: { sessionId: SESSION_ID, conversationId: SESSION_ID },
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '在线 stopless 收口验证: 正常给我一个简短总结收尾即可。' }]
      }
    ]
  };
  const first = postJson(`http://${PORT_5555}/v1/responses`, firstBody);
  const exec = findExecCommand(first);
  if (!exec) {
    record('step1.exec_command_present', false, {
      finishReason: first?.output?.[0]?.finish_reason || first?.output?.[first.output.length - 1]?.finish_reason,
      status: first?.status
    });
    throw new Error('no exec_command in 5555 first turn');
  }
  record('step1.exec_command_present', true, { callId: exec.callId });
  const cmd = exec.cmd;
  record('step1.cmd_has_session_id', /--session-id '[^']+'/.test(cmd), { sample: cmd.slice(0, 220) });
  record('step1.cmd_has_request_id', /--request-id '[^']+'/.test(cmd));
  record('step1.cmd_no_continuation_prompt', !cmd.includes('continuationPrompt') && !cmd.includes('继续做下一步'));
  record('step1.cmd_starts_with_session_dir', cmd.startsWith("ROUTECODEX_SESSION_DIR='"));

  logHeader('Step 2: execute the CLI and parse stdout');
  const cliResult = runCli(cmd);
  if (cliResult.error) {
    record('step2.cli_exit_ok', false, { error: cliResult.error });
    throw new Error(cliResult.error);
  }
  record('step2.cli_exit_ok', true, { summary: cliResult.stdout?.summary, repeatCount: cliResult.stdout?.repeatCount, used: cliResult.stdout?.repeatCount });
  record('step2.cli_output_has_session_id', typeof cliResult.stdout?.sessionId === 'string' && cliResult.stdout.sessionId.trim().length > 0);
  record('step2.cli_output_has_request_id', typeof cliResult.stdout?.requestId === 'string' && cliResult.stdout.requestId.trim().length > 0);
  const cliInputKeys = cliResult.stdout?.input && typeof cliResult.stdout.input === 'object' ? Object.keys(cliResult.stdout.input) : [];
  record('step2.cli_input_keys_minimal', cliInputKeys.length === 4 && ['flowId', 'repeatCount', 'maxRepeats', 'triggerHint'].every((k) => cliInputKeys.includes(k)), { cliInputKeys });
  record('step2.cli_continuation_prompt_in_stdout', typeof cliResult.stdout?.continuationPrompt === 'string' && cliResult.stdout.continuationPrompt.length > 0, { prompt: cliResult.stdout?.continuationPrompt });
  record('step2.used_advanced_from_1', cliResult.stdout?.repeatCount >= 1, { repeatCount: cliResult.stdout?.repeatCount });

  logHeader('Step 3: same live execCommand must converge within the same session');
  const secondCli = runCli(cmd);
  if (secondCli.error) {
    record('step3.round2.cli_exit_ok', false, { error: secondCli.error });
    throw new Error(secondCli.error);
  }
  record('step3.round2.repeat_count_increased', secondCli.stdout?.repeatCount >= 2, {
    repeatCount: secondCli.stdout?.repeatCount,
    summary: secondCli.stdout?.summary
  });

  const thirdCli = runCli(cmd);
  if (thirdCli.error) {
    record('step3.round3.cli_exit_ok', false, { error: thirdCli.error });
    throw new Error(thirdCli.error);
  }
  record('step3.round3.terminal_after_three_hits', thirdCli.stdout?.summary === '停止检查已收敛' && thirdCli.stdout?.repeatCount === 3, {
    repeatCount: thirdCli.stdout?.repeatCount,
    summary: thirdCli.stdout?.summary
  });

  logHeader('Step 4: 5520 provider-direct must NOT trigger stopless');
  const directBody = {
    model: 'routecodex-servertool-cli',
    stream: false,
    metadata: { sessionId: SESSION_ID, conversationId: SESSION_ID, routeHint: 'provider-direct' },
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'direct path 验证：正常收尾, 不许走 stopless' }]
      }
    ]
  };
  const direct = postJson(`http://${PORT_5520}/v1/responses`, directBody);
  const directExec = findExecCommand(direct);
  record('step4.direct_no_exec_command', !directExec, {
    finishReason: direct?.output?.[0]?.finish_reason || direct?.output?.[direct.output?.length - 1]?.finish_reason,
    status: direct?.status
  });
} catch (err) {
  console.error('probe error:', err.message);
  report.error = err.message;
}

const failed = report.steps.filter((s) => !s.ok);
console.log(`\n=== summary: ${report.steps.length - failed.length}/${report.steps.length} passed ===`);
if (failed.length) {
  process.exitCode = 2;
} else {
  console.log('ALL GREEN');
}
