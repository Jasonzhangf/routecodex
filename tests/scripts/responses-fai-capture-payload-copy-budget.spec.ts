import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  buildResponseProbeVariants,
  readExplicitSampleBody
} from '../../scripts/responses-fai-capture.mjs';

describe('feature_id: debug.responses_fai_capture_payload_copy_budget', () => {
  test('source rejects eager full-payload clone variants and invalid-sample fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/responses-fai-capture.mjs'),
      'utf8'
    );

    expect(source).toContain(`function ${'buildResponseProbeVariants'}`);
    expect(source).not.toContain('JSON.parse(JSON.stringify');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
    expect(source).not.toContain('fallback to variants');
  });

  test('lazily projects only the currently requested variant', () => {
    const parameters = { type: 'object', properties: { a: { type: 'number' } } };
    const tool = {
      type: 'function',
      name: 'add',
      description: 'add two numbers',
      parameters
    };
    let mapReads = 0;
    const tools = new Proxy([tool], {
      get(target, property, receiver) {
        if (property === 'map') mapReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    const input = [{ type: 'message', role: 'user', content: [] }];
    const payload = {
      tools,
      tool_choice: 'auto',
      instructions: 'system',
      input
    };
    const variants = buildResponseProbeVariants(payload);

    const first = variants.next().value;
    const second = variants.next().value;
    const third = variants.next().value;
    const fourth = variants.next().value;

    expect(mapReads).toBe(0);
    expect(first).not.toBe(payload);
    expect(first.tools).toBe(tools);
    expect(first.input).toBe(input);
    expect(second.tool_choice).toEqual({
      type: 'function',
      function: { name: 'add' }
    });
    expect(second.tools).toBe(tools);
    expect(third).not.toHaveProperty('instructions');
    expect(third.input).toBe(input);
    expect(fourth).not.toHaveProperty('input');
    expect(fourth.tools).toBe(tools);

    const fifth = variants.next().value;
    expect(mapReads).toBe(1);
    expect(fifth.tools).not.toBe(tools);
    expect(fifth.tools[0]).toEqual({
      type: 'function',
      name: 'add',
      parameters
    });
    expect(fifth.tools[0].parameters).toBe(parameters);

    const sixth = variants.next().value;
    expect(mapReads).toBe(2);
    expect(sixth.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'add',
        description: 'add two numbers',
        parameters
      }
    });
    expect(sixth.tools[0].function.parameters).toBe(parameters);
    expect(variants.next()).toEqual({ done: true, value: undefined });
  });

  test('explicit sample input fails fast instead of switching to generated variants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-fai-copy-budget-'));
    const invalidPath = path.join(dir, 'invalid.json');
    fs.writeFileSync(invalidPath, JSON.stringify([]));

    expect(() => readExplicitSampleBody(path.join(dir, 'missing.json'))).toThrow(
      /sample not found/
    );
    expect(() => readExplicitSampleBody(invalidPath)).toThrow(/invalid sample body/);
  });
});
