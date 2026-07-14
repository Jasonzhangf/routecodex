import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  extractSubmitToolOutputsPayload
} from '../../../../src/providers/core/runtime/responses-provider-helpers.js';

const submitProjectorName = 'extract' + 'SubmitToolOutputsPayload';

describe('Responses provider submit payload copy budget', () => {
  it('derives a shallow top-level wire body without cloning nested protocol payloads', () => {
    const toolOutputs = [{
      call_id: 'call_large',
      output: {
        text: 'x'.repeat(1024),
        extension: { retained: true }
      }
    }];
    const tools = [{
      type: 'function',
      name: 'large_tool',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        }
      }
    }];
    const metadata = { client_protocol_field: { retained: true } };
    const request = {
      response_id: 'resp_submit_copy_budget',
      responseId: 'resp_alias_must_also_be_removed',
      model: 'gpt-test',
      tool_outputs: toolOutputs,
      tools,
      metadata
    };

    const submit = extractSubmitToolOutputsPayload(request);

    expect(submit?.responseId).toBe('resp_submit_copy_budget');
    expect(submit?.body).not.toBe(request);
    expect(submit?.body).not.toHaveProperty('response_id');
    expect(submit?.body).not.toHaveProperty('responseId');
    expect(submit?.body.tool_outputs).toBe(toolOutputs);
    expect(submit?.body.tools).toBe(tools);
    expect(submit?.body.metadata).toBe(metadata);
    expect(request.response_id).toBe('resp_submit_copy_budget');
    expect(request.responseId).toBe('resp_alias_must_also_be_removed');
  });

  it('rejects complete payload deep-clone primitives in the submit body projector', () => {
    const sourcePath = path.join(
      process.cwd(),
      'src/providers/core/runtime/responses-provider-helpers.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');
    const functionSource = source.match(
      new RegExp(`export function ${submitProjectorName}[\\s\\S]*?\\n}\\n\\nexport function buildSubmitToolOutputsEndpoint`)
    )?.[0] ?? '';

    expect(functionSource).not.toMatch(/JSON\.parse\s*\(\s*JSON\.stringify/);
    expect(functionSource).not.toMatch(/structuredClone\s*\(/);
  });
});
