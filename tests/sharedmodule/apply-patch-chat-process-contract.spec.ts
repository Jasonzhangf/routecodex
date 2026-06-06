import { describe, expect, it } from '@jest/globals';

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
}

describe('apply_patch freeform chat-process contract', () => {
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

  it('keeps apply_patch client-native schema by default', () => {
    const processedRequest = runRequestPipeline(
      buildApplyPatchRequest(),
      { originalEndpoint: '/v1/chat/completions' },
      'req-apply-patch-client-mode-contract',
    );

    const tool = (processedRequest as any)?.tools?.[0]?.function;
    expect(tool?.name).toBe('apply_patch');
    const properties = tool?.parameters?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['patch']);
    expect(JSON.stringify(tool)).toContain('*** Begin Patch');
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

    const tool = (processedRequest as any)?.tools?.[0]?.function;
    expect(tool?.name).toBe('apply_patch');
    const toolJson = JSON.stringify(tool);
    expect(toolJson).toContain('*** Begin Patch');
    expect(toolJson.toLowerCase()).not.toContain('hashline');
    expect(toolJson).not.toContain('fileContent');
    expect(toolJson).not.toContain('servertool');
    expect(tool?.parameters?.required).toEqual(['patch']);
  });

  it('never executes apply_patch locally through server-side tool engine', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { runServerSideToolEngine } = await import('../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js');
    const workspace = path.join(process.cwd(), 'tmp', 'jest-apply-patch-freeform-only');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'sample.txt');
    fs.writeFileSync(target, 'old\nkeep\n', 'utf8');

    const result = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-apply-patch-freeform-only',
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
                  patch: '- old\n+ new',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      } as any,
      adapterContext: {
        requestId: 'req-apply-patch-freeform-only',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        cwd: workspace,
        __rt: { applyPatch: { mode: 'servertool' } },
        capturedChatRequest: { model: 'gpt-test', messages: [], tools: [] },
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-freeform-only',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as any }),
    });

    expect(result.mode).toBe('passthrough');
    expect(fs.readFileSync(target, 'utf8')).toBe('old\nkeep\n');
    expect((result.finalChatResponse as any).choices[0].message.tool_calls?.[0]?.function?.name).toBe('apply_patch');
    expect(JSON.stringify(result.finalChatResponse)).not.toContain('APPLY_PATCH_APPLIED');
    expect(result.execution).toBeUndefined();
  });
});
