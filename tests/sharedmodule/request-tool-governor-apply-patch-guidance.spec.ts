import { processChatRequestTools } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.js';

describe('request tool governor apply_patch guidance shape', () => {
  it('does not let TS relay request governor own internal line-edit apply_patch guidance anymore', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Edit files by patch',
            parameters: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'target file path'
                },
                fileContent: {
                  type: 'string',
                  description: 'current file content'
                }
              }
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const patchDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.patch?.description || '');
    const inputDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.input?.description || '');
    expect(patchDesc).toBe('');
    expect(inputDesc).toBe('');
  });

  it('does not inject internal line-edit helper fields at TS relay request governor anymore', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' },
                filePath: {
                  type: 'string',
                  description: 'target file path.'
                },
                file_path: {
                  type: 'string',
                  description: 'target file path.'
                }
              },
              required: ['patch']
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const properties = out?.tools?.[0]?.function?.parameters?.properties || {};
    expect(properties.filePath).toBeDefined();
    expect(properties.file_path).toBeDefined();
    expect(properties.fileContent).toBeUndefined();
    expect(properties.file_content).toBeUndefined();
    expect(properties.patch).toBeDefined();
    expect(properties.input).toBeDefined();
  });

  it('keeps relay apply_patch non-strict so upstream does not rewrite compatibility alias into required fields', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' }
              },
              required: ['patch']
            },
            strict: true
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    expect(out?.tools?.[0]?.function?.strict).toBe(true);
  });

  it('does not duplicate filePath/fileContent aliases at TS relay request governor anymore', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' },
                filePath: {
                  type: 'string',
                  description: 'target file path.'
                },
                fileContent: {
                  type: 'string',
                  description: 'current file content.'
                }
              },
              required: ['patch']
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const properties = out?.tools?.[0]?.function?.parameters?.properties || {};
    expect(properties.filePath).toBeDefined();
    expect(properties.fileContent).toBeDefined();
    expect(properties.file_path).toBeUndefined();
    expect(properties.file_content).toBeUndefined();
    expect(properties.patch).toBeDefined();
    expect(properties.input).toBeDefined();
  });

  it('does not inject client canonical apply_patch grammar at TS relay request governor anymore', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Edit files by patch',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const patchDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.patch?.description || '');
    const inputDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.input?.description || '');
    expect(patchDesc).toBe('');
    expect(inputDesc).toBe('');
  });
});
