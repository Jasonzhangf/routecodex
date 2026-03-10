#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_inbound',
    'req_inbound_stage3_context_capture',
    'tool-output-snapshot.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function decodeArgs(call) {
  assert.equal(typeof call?.function?.arguments, 'string');
  return JSON.parse(call.function.arguments);
}

async function main() {
  const mod = await importFresh('req-inbound-tool-snapshot');
  const buildSnapshot = mod.buildToolOutputSnapshot;
  const collectToolOutputs = mod.collectToolOutputs;
  assert.equal(typeof buildSnapshot, 'function');
  assert.equal(typeof collectToolOutputs, 'function');

  {
    const payload = {};
    const snapshot = buildSnapshot(payload);
    assert.equal(snapshot.providerProtocol, 'unknown');
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'tool_outputs'), false);
  }

  {
    const payload = {
      tools: [{ function: { name: 'exec_command' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ toon: 'echo hi', cwd: '/tmp' })
              }
            }
          ]
        }
      ]
    };
    const snapshot = buildSnapshot(payload, 'openai-responses');
    assert.equal(snapshot.providerProtocol, 'openai-responses');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'shell');
    const args = decodeArgs(call);
    assert.equal(args.cmd, 'echo hi');
    assert.equal(args.command, 'echo hi');
    assert.equal(args.workdir, '/tmp');
    assert.equal(Object.prototype.hasOwnProperty.call(args, 'toon'), false);
  }

  {
    const payload = {
      tools: [{ function: { name: 'shell_command' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'bash',
                arguments: {
                  input: {
                    command: ['echo', 'array', 'cmd'],
                    workdir: '/repo'
                  }
                }
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'bash');
    const args = decodeArgs(call);
    assert.equal(args.cmd, 'echo array cmd');
    assert.equal(args.command, 'echo array cmd');
    assert.equal(args.workdir, '/repo');
  }

  {
    const payload = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'terminal',
                arguments: '{bad-json'
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'terminal');
    assert.equal(call.function.arguments, '{bad-json');
  }

  {
    const payload = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: '   '
              }
            }
          ]
        },
        {
          role: 'user',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ cmd: 'ignored-role' })
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'shell');
    assert.equal(call.function.arguments, '   ');
  }

  {
    const payload = {
      tools: [{ function: { name: 'shell' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ command: 'echo keep-raw' })
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'shell');
    const args = decodeArgs(call);
    assert.equal(args.command, 'echo keep-raw');
  }

  {
    const payload = {
      tools: [{ function: { name: 'read_file' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ cmd: 'echo unresolved-tool' })
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[0].tool_calls[0];
    assert.equal(call.function.name, 'shell');
  }

  {
    const payload = {
      tools: [null, { name: 'shell' }, { function: 123 }, { function: {} }],
      messages: [
        null,
        {
          role: '   ',
          tool_calls: []
        },
        {
          role: 'assistant',
          tool_calls: [
            null,
            { function: 123 },
            { function: {} },
            {
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ command: 'ignored' })
              }
            },
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ command: [null, '   '] })
              }
            },
            {
              function: {
                name: 'shell',
                arguments: '[]'
              }
            },
            {
              function: {
                name: 'shell',
                arguments: JSON.stringify({ input: { cmd: 'echo cwd', cwd: '/via-cwd' } })
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const call = payload.messages[2].tool_calls[6];
    const args = decodeArgs(call);
    assert.equal(args.cmd, 'echo cwd');
    assert.equal(args.workdir, '/via-cwd');
  }

  {
    const payload = {
      tools: [{ function: { name: 'exec_command' } }],
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                name: 'shell',
                arguments: {
                  cmd: 'echo with-cycle',
                  workdir: '/cycle',
                  self: { nested: true }
                }
              }
            },
            {
              function: {
                name: 'shell',
                arguments: 42
              }
            }
          ]
        }
      ]
    };
    buildSnapshot(payload, 'chat');
    const first = payload.messages[0].tool_calls[0];
    const second = payload.messages[0].tool_calls[1];
    assert.equal(typeof first.function.arguments, 'string');
    const firstArgs = JSON.parse(first.function.arguments);
    assert.equal(firstArgs.cmd, 'echo with-cycle');
    assert.equal(firstArgs.workdir, '/cycle');
    assert.equal(second.function.arguments, 42);
  }

  {
    const payload = {
      required_action: {
        submit_tool_outputs: null
      },
      tool_outputs: [null, { tool_call_id: 'ok-id', output: 'ok' }, 0],
      messages: [
        null,
        1,
        { role: 'tool', tool_call_id: 'msg-ok', content: 'msg-ok' },
        { role: 'assistant', content: [null, { type: 'tool_result', tool_use_id: 'blk-ok', content: 'blk-ok' }] }
      ],
      input: [null, { type: 123, tool_call_id: 'ignored' }, { type: 'tool_result', tool_call_id: 'in-ok', output: 'in-ok' }]
    };
    const outputs = collectToolOutputs(payload);
    const ids = new Set(outputs.map((item) => item.tool_call_id || item.call_id));
    assert.deepEqual(Array.from(ids).sort(), ['blk-ok', 'in-ok', 'msg-ok', 'ok-id']);
  }

  {
    const payload = {
      tool_outputs: [{ tool_call_id: 'missing-output' }, { call_id: 'missing-output-2', name: 'shell' }]
    };
    const outputs = collectToolOutputs(payload);
    assert.equal(outputs.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(outputs[0], 'output'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(outputs[1], 'output'), false);
  }

  {
    const payload = Object.create(null);
    let reads = 0;
    Object.defineProperty(payload, 'messages', {
      get() {
        reads += 1;
        if (reads === 1) {
          throw new Error('messages getter boom');
        }
        return [];
      }
    });
    const snapshot = buildSnapshot(payload, 'throw-normalize');
    assert.equal(snapshot.providerProtocol, 'throw-normalize');
  }

  {
    const payload = { messages: [] };
    let reads = 0;
    Object.defineProperty(payload, 'tool_outputs', {
      get() {
        reads += 1;
        if (reads === 1) {
          throw new Error('tool_outputs getter boom');
        }
        return [];
      }
    });
    const snapshot = buildSnapshot(payload, 'throw-diagnostics');
    assert.equal(snapshot.providerProtocol, 'throw-diagnostics');
  }

  {
    const payload = {
      tool_outputs: [
        {
          tool_call_id: 'top-1',
          output: { nested: true },
          name: 'toolA'
        },
        {
          tool_call_id: 'top-content',
          content: 'content-fallback'
        },
        {
          tool_call_id: 'top-dup',
          output: 'top-dup-1'
        },
        {
          call_id: 'top-dup',
          output: 'top-dup-2'
        }
      ],
      required_action: {
        submit_tool_outputs: {
          tool_outputs: [
            { tool_call_id: 'req-1', output: 'required' },
            { output: 'missing-id' },
            null
          ]
        }
      },
      messages: [
        {
          role: 'tool',
          id: 'msg-tool-1',
          name: 'tool-message',
          content: { nested: true }
        },
        {
          call_id: 'msg-call-only',
          content: 'missing-role-should-ignore'
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_result', tool_use_id: 'blk-1', content: { ok: 1 } },
            { type: 'function_call_output', call_id: 'blk-2', output: 'done' },
            { type: 'tool_message', tool_call_id: 'blk-3', output: 'msg' },
            { type: 'tool_result', id: 'blk-id-only', content: 'from-id' },
            { type: 'tool_result', call_id: 'blk-call-only', output: 'from-call-id' },
            { type: 0, id: 'blk-type-number', content: 'ignored-non-string-type' },
            { type: 'text', text: 'ignored' }
          ]
        }
      ],
      input: [
        { type: 'tool_result', tool_call_id: 'in-1', output: 'in-result' },
        { type: 'function_call_output', call_id: 'in-2', output: { json: true } },
        { type: 'tool_message', tool_use_id: 'in-3', output: 'tool-msg' },
        { type: 'message', id: 'ignored' }
      ]
    };

    const outputs = collectToolOutputs(payload);
    const byId = new Map(outputs.map((item) => [item.tool_call_id || item.call_id, item]));

    assert.equal(outputs.length, 13);
    assert.equal(byId.get('top-1')?.output, JSON.stringify({ nested: true }));
    assert.equal(byId.get('top-content')?.output, 'content-fallback');
    assert.equal(byId.get('top-dup')?.output, 'top-dup-1');
    assert.equal(byId.get('req-1')?.output, 'required');
    assert.equal(byId.get('msg-tool-1')?.name, 'tool-message');
    assert.equal(byId.get('blk-1')?.output, JSON.stringify({ ok: 1 }));
    assert.equal(byId.get('blk-2')?.output, 'done');
    assert.equal(byId.get('blk-3')?.output, 'msg');
    assert.equal(byId.get('blk-id-only')?.output, 'from-id');
    assert.equal(byId.get('blk-call-only')?.output, 'from-call-id');
    assert.equal(byId.get('in-1')?.output, 'in-result');
    assert.equal(byId.get('in-2')?.output, JSON.stringify({ json: true }));
    assert.equal(byId.get('in-3')?.output, 'tool-msg');
  }

  {
    const payload = {
      tool_outputs: [
        { tool_call_id: 'patch-a', name: 'apply_patch', output: 'failed to parse function arguments: missing field `input`' },
        { tool_call_id: 'diag-noname', output: 'failed to parse function arguments: missing field `cmd`' },
        { tool_call_id: 'diag-nontext', name: 'shell', output: 123 }
      ],
      required_action: {
        submit_tool_outputs: {
          tool_outputs: [
            { tool_call_id: 'patch-b', name: 'apply_patch', output: 'failed to parse function arguments: invalid type: map, expected a string' },
            { tool_call_id: 'ignored-apply', name: 'not_apply_patch', output: 'failed to parse function arguments: missing field `input`' },
            null
          ]
        }
      },
      messages: [
        null,
        {
          role: 'tool',
          tool_call_id: 'shell-a',
          name: 'shell_command',
          content: 'failed to parse function arguments: missing field `command`'
        },
        {
          role: 'tool',
          tool_call_id: 'shell-b',
          name: 'exec_command',
          output: 'failed to parse function arguments: missing field `cmd`'
        },
        {
          role: 'tool',
          tool_call_id: 'shell-ignore-name',
          name: 'read_file',
          output: 'failed to parse function arguments: missing field `command`'
        },
        {
          role: 'assistant',
          content: [
            null,
            {
              type: 'tool_result',
              tool_use_id: 'blk-shell',
              name: 'shell',
              output: 'failed to parse function arguments: missing field `cmd`'
            },
            {
              type: 'tool_result',
              tool_use_id: 'blk-already',
              name: 'shell',
              output: '[RouteCodex precheck] existing marker'
            }
          ]
        },
        {
          role: 1,
          content: [null]
        }
      ],
      input: [
        {
          type: 'tool_result',
          tool_call_id: 'in-shell',
          name: 'bash',
          output: 'failed to parse function arguments: missing field `command`'
        },
        {
          type: 'tool_result',
          tool_call_id: 'in-apply',
          name: 'apply_patch',
          output: 'failed to parse function arguments: missing field `input`'
        },
        {
          type: 'tool_result',
          tool_call_id: 'diag-unknown',
          name: 'apply_patch',
          output: 'failed to parse function arguments: unknown reason'
        },
        {
          type: 'tool_result',
          tool_call_id: 'in-none',
          name: 'apply_patch',
          output: 'normal output'
        },
        null,
        {
          type: 0,
          tool_call_id: 'diag-type-non-string',
          name: 'shell',
          output: 'failed to parse function arguments: missing field `command`'
        }
      ]
    };

    buildSnapshot(payload, 'diag');

    assert.ok(payload.tool_outputs[0].output.includes('缺少字段 "input"'));
    assert.ok(payload.required_action.submit_tool_outputs.tool_outputs[0].output.includes('参数类型错误'));
    assert.equal(payload.required_action.submit_tool_outputs.tool_outputs[1].output.includes('[RouteCodex precheck]'), false);
    assert.ok(payload.tool_outputs[1].output.includes('缺少字段 "cmd"'));
    assert.equal(payload.tool_outputs[2].output, 123);

    assert.ok(payload.messages[1].content.includes('缺少字段 "command"'));
    assert.ok(payload.messages[2].output.includes('缺少字段 "cmd"'));
    assert.equal(payload.messages[3].output.includes('[RouteCodex precheck]'), false);

    const assistantBlocks = payload.messages[4].content;
    assert.ok(assistantBlocks[1].output.includes('缺少字段 "cmd"'));
    assert.equal(assistantBlocks[2].output, '[RouteCodex precheck] existing marker');

    assert.ok(payload.input[0].output.includes('缺少字段 "command"'));
    assert.ok(payload.input[1].output.includes('缺少字段 "input"'));
    assert.equal(payload.input[2].output, 'failed to parse function arguments: unknown reason');
    assert.equal(payload.input[3].output, 'normal output');
  }

  console.log('✅ coverage-hub-req-inbound-context-tool-snapshot passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-inbound-context-tool-snapshot failed:', error);
  process.exit(1);
});
