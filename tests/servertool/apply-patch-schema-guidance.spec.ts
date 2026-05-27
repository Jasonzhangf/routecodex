import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

function buildRequest(): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'edit files' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'native placeholder',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input']
          }
        }
      } as any
    ],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('apply_patch provider-facing schema guidance', () => {
  test('aligns schema guidance with handler capabilities for weak-model compatibility', async () => {
    const result = await runReqProcessStage1ToolGovernance({
      request: buildRequest(),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { applyPatch: { mode: 'servertool' } } },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-schema-guidance'
    });

    const processed = result.processedRequest as any;
    const applyPatch = processed.tools.find((tool: any) => tool?.function?.name === 'apply_patch');
    expect(applyPatch).toBeTruthy();
    const description = String(applyPatch.function.description || '');
    const patchDescription = String(applyPatch.function.parameters.properties.patch.description || '');
    const schemaText = JSON.stringify(applyPatch);

    expect(applyPatch.function.parameters.required).toEqual(['patch']);
    expect(applyPatch.function.parameters.additionalProperties).toBe(true);
    expect(description).toContain('`filePath` is optional');
    expect(description).toContain('*** Add File:');
    expect(description).toContain('--- a/');
    expect(description).toContain('```diff');
    expect(patchDescription).toContain('line-edit');
    expect(patchDescription).toContain('unified diff');
    expect(patchDescription).toContain('Markdown fenced code block');
    expect(schemaText).not.toContain('fileContent');
    expect(schemaText).not.toContain('input');
    expect(schemaText).not.toContain('cat');
    expect(schemaText).not.toContain('shell');
  });
});
