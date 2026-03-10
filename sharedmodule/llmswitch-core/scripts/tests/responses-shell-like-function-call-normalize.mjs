#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runReqInboundStage3ContextCapture } from '../../dist/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/index.js';

async function runCaseExecPreferred() {
  const rawRequest = {
    model: 'gpt-5.1',
    tools: [
      {
        type: 'function',
        function: { name: 'exec_command', description: 'Run shell command' }
      }
    ],
    input: [
      {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({
          cmd: ['git', 'status'],
          cwd: '/workspace'
        }),
        call_id: 'call_exec_1',
        id: 'call_exec_1'
      }
    ]
  };

  await runReqInboundStage3ContextCapture({
    rawRequest,
    adapterContext: {
      requestId: 'req_exec_preferred',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    }
  });

  const call = rawRequest.input[0];
  assert.equal(call.name, 'exec_command', 'shell-like function_call should map to exec_command when requested');
  const args = JSON.parse(call.arguments);
  assert.equal(args.cmd, 'git status', 'cmd array should normalize to joined string');
  assert.equal(args.command, 'git status', 'command mirror should be present');
  assert.equal(args.workdir, '/workspace', 'cwd should normalize to workdir');
}

async function runCaseShellPreferred() {
  const rawRequest = {
    model: 'gpt-5.1',
    tools: [
      {
        type: 'function',
        function: { name: 'shell_command', description: 'Run shell command' }
      }
    ],
    input: [
      {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({
          command: 'ls -la'
        }),
        call_id: 'call_shell_1',
        id: 'call_shell_1'
      }
    ]
  };

  await runReqInboundStage3ContextCapture({
    rawRequest,
    adapterContext: {
      requestId: 'req_shell_preferred',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    }
  });

  const call = rawRequest.input[0];
  assert.equal(call.name, 'shell_command', 'shell-like function_call should keep shell_command when requested');
  const args = JSON.parse(call.arguments);
  assert.equal(args.command, 'ls -la', 'command should be preserved');
  assert.equal(args.cmd, 'ls -la', 'cmd mirror should be present for cross-tool compatibility');
}

async function runCaseNoToolsDefaultsToExec() {
  const rawRequest = {
    model: 'gpt-5.1',
    input: [
      {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({
          cmd: 'pwd'
        }),
        call_id: 'call_shell_2',
        id: 'call_shell_2'
      }
    ]
  };

  await runReqInboundStage3ContextCapture({
    rawRequest,
    adapterContext: {
      requestId: 'req_no_tools_default_exec',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    }
  });

  const call = rawRequest.input[0];
  assert.equal(call.name, 'exec_command', 'without tools list, shell-like call should default to exec_command');
  const args = JSON.parse(call.arguments);
  assert.equal(args.cmd, 'pwd', 'cmd should be preserved');
  assert.equal(args.command, 'pwd', 'command mirror should be present');
}

async function main() {
  await runCaseExecPreferred();
  await runCaseShellPreferred();
  await runCaseNoToolsDefaultsToExec();
  console.log('[matrix:responses-shell-like-function-call-normalize] ok');
}

main().catch((err) => {
  console.error('[matrix:responses-shell-like-function-call-normalize] failed', err);
  process.exit(1);
});
