import { describe, expect, test } from '@jest/globals';

import { parseRoutingInstructions } from '../../src/router/virtual-router/routing-instructions/parse.js';

describe('stopMessage shorthand parsing', () => {
  test('quoted stopMessage shorthand does not emit routing allow tokens', () => {
    const instructions = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**"继续执行",ai:on,10**>'
      } as any
    ]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('stopMessageSet');
    expect((instructions[0] as any).stopMessageMaxRepeats).toBe(10);
    expect((instructions[0] as any).stopMessageAiMode).toBe('on');
  });
});
