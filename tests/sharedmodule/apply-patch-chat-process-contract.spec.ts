import { describe, expect, it, jest } from '@jest/globals';

import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { runHubPipelineLibWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';

function runRequestPipeline(request: StandardizedRequest, metadata: Record<string, unknown>, requestId: string) {
  const result = runHubPipelineLibWithNative({
    config: { virtualRouter: {} },
    request: {
      requestId,
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      payload: request as unknown as Record<string, unknown>,
      metadata: {
        ...metadata,
        __routecodexPreselectedRoute: {
          target: { providerKey: 'test.key1.gpt-test', modelId: 'gpt-test', outboundProfile: 'openai-chat' },
          decision: { routeName: 'test/preselected' },
          diagnostics: {},
        },
      },
      stream: false,
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
    },
  });
  if (result.success !== true) {
    throw new Error(result.error?.message ?? 'Rust HubPipeline request pipeline failed');
  }
  return result.payload as unknown as StandardizedRequest;
}

describe('apply_patch chat-process contract', () => {
  it('keeps hub envelope standardization out of apply_patch argument rewriting', async () => {
    const { coerceStandardizedRequestFromPayloadWithNative } = await import(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-builders.js'
    );
    const inputPatch = '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch\n';
    const output = coerceStandardizedRequestFromPayloadWithNative({
          payload: {
            model: 'gpt-test',
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({ input: inputPatch }),
                    },
                  },
                ],
              },
            ],
            tools: [{ type: 'function', function: { name: 'apply_patch' } }],
            parameters: {},
          },
          normalized: {
            id: 'req-apply-patch-envelope',
            entryEndpoint: '/v1/chat/completions',
            stream: false,
            processMode: 'chat',
          },
        });

    const argsText = output.standardizedRequest.messages[0].tool_calls[0].function.arguments;
    const args = JSON.parse(argsText);
    expect(args.input).toBe(inputPatch);
    expect(args.patch).toBeUndefined();
  });

  it('keeps apply_patch client-native schema by default in client mode', async () => {
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit a file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'canonical client apply_patch tool',
            parameters: {
              type: 'object',
              properties: {
                patch: {
                  type: 'string',
                  description: 'Patch text using *** Begin Patch / *** End Patch grammar.',
                },
              },
              required: ['patch'],
              additionalProperties: false,
            },
          },
        },
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions' },
    };

    const processedRequest = runRequestPipeline(
      request,
      { originalEndpoint: '/v1/chat/completions' },
      'req-apply-patch-client-mode-contract',
    );

    const tool = (processedRequest as any)?.tools?.[0]?.function;
    expect(tool?.name).toBe('apply_patch');
    const properties = tool?.parameters?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['patch']);
    expect(JSON.stringify(tool)).toContain('*** Begin Patch');
    expect(JSON.stringify(tool)).not.toContain('fileContent');
  });

  it('rewrites apply_patch tool schema to internal line-edit format when servertool mode is configured', async () => {
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit a file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'canonical client apply_patch tool',
            parameters: {
              type: 'object',
              properties: {
                patch: {
                  type: 'string',
                  description: 'Patch text using *** Begin Patch / *** End Patch grammar.',
                },
              },
              required: ['patch'],
              additionalProperties: false,
            },
          },
        },
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions' },
    };

    const processedRequest = runRequestPipeline(
      request,
      {
        originalEndpoint: '/v1/chat/completions',
        __rt: { applyPatch: { mode: 'servertool' } },
      },
      'req-apply-patch-servertool-mode-contract',
    );

    const tool = (processedRequest as any)?.tools?.[0]?.function;
    expect(tool?.name).toBe('apply_patch');
    expect(String(tool?.description)).toContain('workspace-relative');
    const properties = tool?.parameters?.properties ?? {};
    const patchDescription = String(properties.patch?.description);
    const toolJson = JSON.stringify(tool);
    expect(patchDescription).toContain('+ first line');
    expect(patchDescription).toContain('- old line');
    expect(patchDescription).toContain('+ new line');
    expect(toolJson).not.toContain('*** Begin Patch');
    expect(toolJson.toLowerCase()).not.toContain('hashline');
    expect(toolJson).toContain('tmp/example.txt');
    expect(toolJson).toContain('src/main.ts');
    expect(Object.keys(properties).sort()).toEqual(['filePath', 'patch']);
    expect(tool?.parameters?.required).toEqual(['filePath', 'patch']);
    expect(tool?.strict).toBe(false);
  });
  it('executes apply_patch locally only in servertool mode and strips the client tool call', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServerSideToolEngine } = await import('../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-servertool');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\nkeep\n', 'utf8');

    const chatResponse = {
      id: 'chatcmpl-apply-patch-servertool',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_patch_1',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({
                filePath: 'sample.txt',
                fileContent: 'old\nkeep\n',
                patch: '- old\n+ new'
              })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-apply-patch-servertool-execute',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        __rt: { applyPatch: { mode: 'servertool' } },
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'edit sample' }],
          tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-servertool-execute',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as any })
    });

    expect(result.mode).toBe('tool_flow');
    expect(fs.readFileSync(target, 'utf8')).toBe('new\nkeep\n');
    expect((result.finalChatResponse as any).choices[0].message.tool_calls).toBeUndefined();
    expect(JSON.stringify(result.finalChatResponse)).toContain('APPLY_PATCH_APPLIED');
    expect(result.execution?.followup).toBeTruthy();
  });

  it('recovers servertool apply_patch filePath and patch from malformed JSON arguments', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServerSideToolEngine } = await import('../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-malformed-json');
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\n', 'utf8');

    const chatResponse = {
      id: 'chatcmpl-apply-patch-malformed-json',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_patch_malformed_json',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: '{"filePath":"sample.txt","fileContent":"old\\n","patch":"- old\\n+ new",'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-apply-patch-malformed-json',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        __rt: { applyPatch: { mode: 'servertool' } },
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'edit sample' }],
          tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-malformed-json',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as any })
    });

    expect(result.mode).toBe('tool_flow');
    expect(fs.readFileSync(target, 'utf8')).toBe('new\n');
    const output = (result.finalChatResponse as any).tool_outputs[0];
    expect(JSON.parse(output.arguments)).toEqual({ filePath: 'sample.txt', patch: '- old\n+ new' });
    expect(JSON.stringify(result.finalChatResponse)).not.toContain('fileContent');
  });

  it('does not execute or strip apply_patch in default client mode', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServerSideToolEngine } = await import('../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-client');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\n', 'utf8');
    const chatResponse = {
      id: 'chatcmpl-apply-patch-client',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_patch_client',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ filePath: 'sample.txt', fileContent: 'old\n', patch: '- old\n+ new' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-apply-patch-client-execute',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        capturedChatRequest: { model: 'gpt-test', messages: [], tools: [] }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-client-execute',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as any })
    });

    expect(result.mode).toBe('passthrough');
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
    expect(JSON.stringify(result.finalChatResponse)).toContain('tool_calls');
    expect(JSON.stringify(result.finalChatResponse)).toContain('apply_patch');
  });


  it('servertool mode executes apply_patch through standard followup skeleton and never client/tmux inject', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServerSideToolEngine } = await import('../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-orchestration');
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\nkeep\n', 'utf8');

    const chatResponse = {
      id: 'chatcmpl-apply-patch-orchestration',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_patch_orch',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({
                filePath: 'sample.txt',
                fileContent: 'old\nkeep\n',
                patch: '- old\n+ new'
              })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    } as any;

    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as const));
    const reenterPipeline = jest.fn(async (opts: any) => ({
      body: {
        id: 'chatcmpl-apply-patch-followup',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'patched' }, finish_reason: 'stop' }],
        __seenFollowupMessages: opts?.body?.messages
      } as any
    }));

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-apply-patch-orchestration',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        __rt: { applyPatch: { mode: 'servertool' } },
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'edit sample' }],
          tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-orchestration',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('apply_patch_flow');
    expect(fs.readFileSync(target, 'utf8')).toBe('new\nkeep\n');
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(result.execution?.followup).toBeTruthy();
    expect((result.finalChatResponse as any).choices[0].message.tool_calls).toBeUndefined();
    expect(JSON.stringify(result.finalChatResponse)).toContain('APPLY_PATCH_APPLIED');

  });


  it('servertool mode apply_patch followup uses persisted origin when response adapter context lacks captured request', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServertoolResponseStageOrchestrationShell } = await import('../../sharedmodule/llmswitch-core/dist/servertool/response-stage-orchestration-shell.js');
    const { saveOriginSnapshot } = await import('../../sharedmodule/llmswitch-core/dist/servertool/origin-request-store.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-origin-store');
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\n', 'utf8');
    const scope = 'session:apply-patch-origin-store';
    saveOriginSnapshot(scope, {
      requestId: 'req-origin-seed',
      sessionScope: scope,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'edit sample' }],
        tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }]
      } as any,
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit sample' }] as any,
      tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }] as any,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    const chatResponse = {
      id: 'chatcmpl-apply-patch-origin-store',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_patch_origin_store',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ filePath: 'sample.txt', fileContent: 'old\n', patch: '- old\n+ new' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    } as any;

    const reenterPipeline = jest.fn(async (opts: any) => ({
      body: {
        id: 'chatcmpl-apply-patch-origin-followup',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'patched after followup' }, finish_reason: 'stop' }],
        __seenFollowupMessages: opts?.body?.messages
      } as any
    }));

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: chatResponse,
      adapterContext: {
        requestId: 'req-apply-patch-origin-store',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        sessionId: 'apply-patch-origin-store',
        __rt: { applyPatch: { mode: 'servertool' } }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-origin-store',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('apply_patch_flow');
    expect(fs.readFileSync(target, 'utf8')).toBe('new\n');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
    const followupBody = reenterPipeline.mock.calls[0][0].body;
    expect(JSON.stringify(followupBody)).toContain('APPLY_PATCH_APPLIED');
    expect(JSON.stringify(followupBody)).toContain('tool_calls');
    const assistantMessage = followupBody.messages.find((message: any) => Array.isArray(message?.tool_calls));
    const followupArgs = JSON.parse(assistantMessage.tool_calls[0].function.arguments);
    expect(followupArgs).toEqual({ filePath: 'sample.txt', patch: '- old\n+ new' });
    expect(JSON.stringify(followupBody)).not.toContain('fileContent');
    expect(JSON.stringify(followupBody)).not.toContain('*** Begin Patch');
    expect(JSON.stringify((result.payload as any).choices)).not.toContain('tool_calls');
    expect(JSON.stringify((result.payload as any).choices)).toContain('patched after followup');
  });

});
