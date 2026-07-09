import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { runHubPipelineLibWithNative } from './helpers/hub-pipeline-orchestration-direct-native.js';
import { coerceStandardizedRequestFromPayloadDirectNative } from './helpers/hub-pipeline-builders-direct-native.js';

type StandardizedRequest = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function runRequestPipeline(request: StandardizedRequest, metadata: Record<string, unknown>, requestId: string) {
  const preselectedRoute = {
    target: {
      providerKey: 'test.key1.gpt-test',
      providerType: 'openai',
      runtimeKey: 'test.key1',
      modelId: 'gpt-test',
      outboundProfile: 'openai-chat',
    },
    decision: { routeName: 'default' },
    diagnostics: {},
  };
  const result = runHubPipelineLibWithNative({
    config: {
      virtualRouter: {
        providers: {
          'test.key1.gpt-test': preselectedRoute.target,
        },
        routing: {
          default: [{
            id: 'default-priority',
            priority: 100,
            mode: 'priority',
            targets: ['test.key1.gpt-test'],
          }],
        },
      },
    },
    request: {
      requestId,
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      payload: request as unknown as Record<string, unknown>,
      metadata: {
        ...metadata,
        runtime_control: {
          ...((metadata as any).runtime_control ?? {}),
          preselectedRoute,
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

function buildApplyPatchRequest(): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'edit a file' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'canonical client apply_patch tool',
        },
      },
    ],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' },
  };
}

describe('apply_patch freeform chat-process contract', () => {
  it('keeps hub envelope standardization out of apply_patch argument rewriting', async () => {
    const inputPatch = '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch\n';
    const output = coerceStandardizedRequestFromPayloadDirectNative({
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

  it('keeps apply_patch client-native schema by default', () => {
    const processedRequest = runRequestPipeline(
      buildApplyPatchRequest(),
      { originalEndpoint: '/v1/chat/completions' },
      'req-apply-patch-client-mode-contract',
    );

    const tool = (processedRequest as any)?.tools?.[0];
    expect(tool?.type).toBe('custom');
    expect(tool?.name).toBe('apply_patch');
    expect(tool?.format?.type).toBe('grammar');
    expect(tool?.format?.syntax).toBe('lark');
    expect(tool?.parameters).toBeUndefined();
    expect(JSON.stringify(tool)).not.toContain('"patch"');
    expect(JSON.stringify(tool)).not.toContain('fileContent');
    expect(JSON.stringify(tool)).not.toContain('servertool');
  });

  it('keeps apply_patch client-native schema even when legacy servertool metadata is present', () => {
    const processedRequest = runRequestPipeline(
      buildApplyPatchRequest(),
      {
        originalEndpoint: '/v1/chat/completions',
        __rt: { applyPatch: { mode: 'servertool' } },
      },
      'req-apply-patch-legacy-servertool-mode-contract',
    );

    const tool = (processedRequest as any)?.tools?.[0];
    expect(tool?.type).toBe('custom');
    expect(tool?.name).toBe('apply_patch');
    const toolJson = JSON.stringify(tool);
    expect(tool?.format?.type).toBe('grammar');
    expect(tool?.format?.syntax).toBe('lark');
    expect(toolJson.toLowerCase()).not.toContain('hashline');
    expect(toolJson).not.toContain('fileContent');
    expect(toolJson).not.toContain('servertool');
    expect(tool?.parameters).toBeUndefined();
  });

  it('canonicalizes apply_patch failure guidance before tool history re-enters standardized messages', async () => {
    const output = coerceStandardizedRequestFromPayloadDirectNative({
      payload: {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_patch_error',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: '*** Begin Patch\n*** Update File: note.txt\n@@\n-old\n+new\n*** End Patch\n',
                },
              },
            ],
          },
          {
            role: 'tool',
            name: 'apply_patch',
            tool_call_id: 'call_patch_error',
            content:
              'apply_patch verification failed: invalid patch: Failed to find expected lines in /tmp/demo.txt',
          },
        ],
        tools: [{ type: 'function', function: { name: 'apply_patch' } }],
        parameters: {},
      },
      normalized: {
        id: 'req-apply-patch-failure-guidance-contract',
        entryEndpoint: '/v1/chat/completions',
        stream: false,
        processMode: 'chat',
      },
    });

    const messages = Array.isArray(output.standardizedRequest.messages)
      ? output.standardizedRequest.messages
      : [];
    const toolMessage = messages.find((message: any) => message?.role === 'tool');
    const content = toolMessage?.content;
    expect(typeof content).toBe('string');
    expect(content).toContain('APPLY_PATCH_ERROR: apply_patch did not apply');
    expect(content).toContain('Retry with apply_patch only');
    expect(content).toContain('workspace-relative');
    expect(content).toContain('Do not switch to exec_command');
    expect(content).not.toContain('verification failed');
    expect(content).not.toContain('/tmp/demo.txt');
  });

  it('never executes apply_patch locally through server-side tool engine', async () => {
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-freeform-only');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\nkeep\n', 'utf8');

    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts')).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('old\nkeep\n');
  });
});
