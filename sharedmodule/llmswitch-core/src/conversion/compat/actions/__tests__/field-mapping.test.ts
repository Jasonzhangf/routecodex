import { applyFieldMappings } from '../field-mapping.js';

describe('field-mapping native wrapper', () => {
  test('maps nested fields with transform and type coercion', () => {
    const payload = {
      model: 'gpt-4.1',
      response: {
        finish_reason: 'sensitive'
      }
    } as any;

    const result = applyFieldMappings(payload, [
      {
        sourcePath: 'model',
        targetPath: 'normalized.model',
        type: 'string',
        transform: 'normalizeModelName'
      },
      {
        sourcePath: 'response.finish_reason',
        targetPath: 'normalized.finish_reason',
        type: 'string',
        transform: 'normalizeFinishReason'
      }
    ]);

    expect(result.normalized.model).toBe('glm-4.1');
    expect(result.normalized.finish_reason).toBe('content_filter');
  });

  test('collects wildcard values into an array target', () => {
    const payload = {
      choices: [
        { message: { role: 'assistant' } },
        { message: { role: 'tool' } }
      ]
    } as any;

    const result = applyFieldMappings(payload, [
      {
        sourcePath: 'choices.[*].message.role',
        targetPath: 'summary.roles',
        type: 'array'
      }
    ]);

    expect(result.summary.roles).toEqual(['assistant', 'tool']);
  });
});
