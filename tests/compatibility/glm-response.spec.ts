import path from 'path';
import { BaseCompatibility } from '../../src/modules/pipeline/modules/compatibility/base-compatibility';

describe('GLM compatibility – response mapping arguments object->string', () => {
  test('applyResponseFilter stringifies function.arguments to string for client (OpenAI)', async () => {
    const shapePath = path.resolve(process.cwd(), 'src/modules/pipeline/modules/compatibility/glm/config/shape-filters.json');
    const compat = new BaseCompatibility(
      { logger: { logModule: () => undefined } },
      { providerType: 'glm', shapeFilterConfigPath: shapePath }
    );
    await compat.initialize();

    const upstream = {
      id: 'id',
      model: 'glm-4.5-air',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { type: 'function', function: { name: 'shell', arguments: { command: ['ls', '-la'] } }, id: 'call_x' },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    } as any;

    const out = await compat.processOutgoing(upstream as any, {} as any);
    const fnArgs = out?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    expect(typeof fnArgs).toBe('string');
    try { JSON.parse(fnArgs); } catch { throw new Error('arguments is not valid JSON string'); }
  });
});

