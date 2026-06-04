import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import '../../sharedmodule/llmswitch-core/dist/servertool/handlers/apply-patch.js';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/dist/servertool/server-side-tools.js';
import { applyFollowupDeltaPlan } from '../../sharedmodule/llmswitch-core/dist/servertool/followup-origin-delta.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/dist/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/dist/conversion/hub/types/json.js';

function makeApplyPatchResponse(argumentsText: string): JsonObject {
  return {
    id: 'chatcmpl-apply-patch-test',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_apply_patch_test',
          type: 'function',
          function: { name: 'apply_patch', arguments: argumentsText }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  } as JsonObject;
}

function makeAdapterContext(workspace: string): AdapterContext {
  return {
    requestId: 'req-apply-patch-test',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    cwd: workspace,
    __rt: { applyPatch: { mode: 'servertool' } },
    metadata: { __rt: { applyPatch: { mode: 'servertool' } } },
    capturedChatRequest: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'edit target' }],
      tools: [
        { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
      ]
    }
  } as any;
}

describe('apply_patch servertool flow', () => {
  test('creates a workspace-relative file from plus-only line-edit patch', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-create-jest-'));
    const adapterContext = makeAdapterContext(workspace);

    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(JSON.stringify({
        filePath: 'tmp/apply_patch_test.txt',
        patch: '+ first line\n+ second line\n+ third line'
      })),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-create-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    await expect(fs.readFile(path.join(workspace, 'tmp/apply_patch_test.txt'), 'utf8')).resolves.toBe(
      'first line\nsecond line\nthird line\n'
    );
    const finalChatResponse = result.finalChatResponse as any;
    const output = JSON.parse(finalChatResponse.tool_outputs[0].content);
    expect(output.ok).toBe(true);
    expect(output.filePath).toBe('tmp/apply_patch_test.txt');
    expect(finalChatResponse.tool_outputs[0].arguments).toBe(JSON.stringify({
      filePath: 'tmp/apply_patch_test.txt',
      patch: '+ first line\n+ second line\n+ third line'
    }));
  });

  test('recovers malformed arguments, executes with canonical args, and builds clean followup delta', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-jest-'));
    await fs.writeFile(path.join(workspace, 'target.txt'), 'old\n', 'utf8');

    const malformed = '{"filePath":"target.txt","fileContent":"old\\n","patch":"- old\\n+ new",';
    const adapterContext = makeAdapterContext(workspace);
    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(malformed),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('apply_patch_flow');
    expect(result.execution?.followup).toMatchObject({
      requestIdSuffix: ':apply_patch_followup',
      entryEndpoint: '/v1/chat/completions',
      injection: {
        ops: [
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      }
    });
    await expect(fs.readFile(path.join(workspace, 'target.txt'), 'utf8')).resolves.toBe('new\n');

    const finalChatResponse = result.finalChatResponse as any;
    expect(finalChatResponse.choices[0].finish_reason).toBe('tool_calls');
    expect(finalChatResponse.choices[0].message.tool_calls).toBeUndefined();
    expect(finalChatResponse.tool_outputs).toHaveLength(1);
    expect(finalChatResponse.tool_outputs[0].arguments).toBe(JSON.stringify({ filePath: 'target.txt', patch: '- old\n+ new' }));
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('fileContent');
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('*** Begin Patch');

    const payload = applyFollowupDeltaPlan({
      adapterContext,
      finalChatResponse: result.finalChatResponse as JsonObject,
      seed: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'edit target' }],
        tools: [
          { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } } as JsonObject,
          { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } } as JsonObject
        ]
      },
      injection: result.execution!.followup!.injection as any
    }) as any;

    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_apply_patch_test',
        type: 'function',
        function: { name: 'apply_patch', arguments: JSON.stringify({ filePath: 'target.txt', patch: '- old\n+ new' }) }
      }]
    });
    expect(payload.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_apply_patch_test'
    });
    expect(payload.tools).toEqual([
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
    ]);
    expect(JSON.stringify(payload)).not.toContain('fileContent');
    expect(JSON.stringify(payload)).not.toContain('*** Begin Patch');
  });

  test('canonicalizes native patch syntax before tool output and followup history', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-native-jest-'));
    await fs.writeFile(path.join(workspace, 'target.txt'), 'old\n', 'utf8');
    const nativePatch = [
      '*** Begin Patch',
      '*** Update File: target.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch'
    ].join('\n');
    const adapterContext = makeAdapterContext(workspace);
    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(JSON.stringify({ input: nativePatch })),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-native-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    await expect(fs.readFile(path.join(workspace, 'target.txt'), 'utf8')).resolves.toBe('new\n');
    const finalChatResponse = result.finalChatResponse as any;
    expect(finalChatResponse.tool_outputs[0].arguments).toBe(JSON.stringify({ filePath: 'target.txt', patch: '- old\n+ new' }));
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('*** Begin Patch');
  });

  test('rejects prose-only patch semantics instead of guessing filePath or edit intent', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-nl-jest-'));
    const adapterContext = makeAdapterContext(workspace);
    const naturalLanguageArgs = JSON.stringify({
      patch: [
        '现在我们知道了正确的 schema: filePath 和 patch(diff 格式)。',
        '测试新建文件（正确格式）：',
        'filePath: "created.txt"',
        'patch:',
        '+ hello from recovered natural language',
        '+ second line'
      ].join('\n')
    });

    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(naturalLanguageArgs),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-natural-language-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    await expect(fs.readFile(path.join(workspace, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const finalChatResponse = result.finalChatResponse as any;
    const output = JSON.parse(finalChatResponse.tool_outputs[0].content);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('PATH_MISSING');
    expect(output.nextAction).toContain('workspace-relative filePath');
    expect(output.nextAction).toContain('Create file');
    expect(output.nextAction).toContain(JSON.stringify({ filePath: 'tmp/example.txt', patch: '+ hello' }));
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('input');
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('fileContent');
  });

  test('file-not-found update error teaches create-file and existing-file forms without shell fallback', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-missing-file-jest-'));
    const adapterContext = makeAdapterContext(workspace);

    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(JSON.stringify({
        filePath: 'missing.txt',
        patch: '- old\n+ new'
      })),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-missing-file-guidance-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    const finalChatResponse = result.finalChatResponse as any;
    const output = JSON.parse(finalChatResponse.tool_outputs[0].content);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('FILE_NOT_FOUND');
    expect(output.nextAction).toContain('Create file');
    expect(output.nextAction).toContain('Update existing file');
    expect(output.nextAction).toContain(JSON.stringify({ filePath: 'missing.txt', patch: '+ hello' }));
    expect(output.nextAction).not.toContain('exec_command');
    expect(output.nextAction).not.toContain('cat');
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('fileContent');
  });

  test('accepts explicit filePath with fenced line-edit patch and repairs line spacing only', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-apply-patch-fence-jest-'));
    const adapterContext = makeAdapterContext(workspace);
    const fencedArgs = JSON.stringify({
      filePath: 'created.txt',
      patch: [
        'schema reminder outside the patch fence must be ignored',
        '```diff',
        '+hello from fenced patch',
        '+second line',
        '```'
      ].join('\n')
    });

    const result = await runServerSideToolEngine({
      chatResponse: makeApplyPatchResponse(fencedArgs),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-fenced-test',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    await expect(fs.readFile(path.join(workspace, 'created.txt'), 'utf8')).resolves.toBe(
      'hello from fenced patch\nsecond line\n'
    );
    const finalChatResponse = result.finalChatResponse as any;
    expect(finalChatResponse.tool_outputs[0].arguments).toBe(JSON.stringify({
      filePath: 'created.txt',
      patch: '+ hello from fenced patch\n+ second line'
    }));
    expect(JSON.stringify(finalChatResponse.tool_outputs)).not.toContain('schema reminder');
  });
});
