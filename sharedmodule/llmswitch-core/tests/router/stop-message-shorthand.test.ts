import { describe, expect, test } from '@jest/globals';

import { parseRoutingInstructions } from '../../src/native/router-hotpath/native-virtual-router-routing-instructions-semantics.js';

describe('stopMessage shorthand parsing', () => {
  test('long stopMessage prefix supports text+count format', () => {
    const instructions = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**stopMessage:"继续执行",10**>'
      } as any
    ]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('stopMessageSet');
    expect((instructions[0] as any).stopMessageText).toBe('继续执行');
    expect((instructions[0] as any).stopMessageMaxRepeats).toBe(10);
  });

  test('sm shorthand supports goal+round format', () => {
    const instructions = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**sm:"继续修复",30**>'
      } as any
    ]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('stopMessageSet');
    expect((instructions[0] as any).stopMessageText).toBe('继续修复');
    expect((instructions[0] as any).stopMessageMaxRepeats).toBe(30);
    expect((instructions[0] as any).stopMessageAiMode).toBe('on');
  });

  test('sm shorthand supports mode/count path', () => {
    const instructions = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**sm:on/30**>'
      } as any
    ]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('stopMessageSet');
    expect((instructions[0] as any).stopMessageText).toBe('继续执行');
    expect((instructions[0] as any).stopMessageMaxRepeats).toBe(30);
    expect((instructions[0] as any).stopMessageAiMode).toBe('on');
  });

  test('sm shorthand supports off clear path', () => {
    const instructions = parseRoutingInstructions([
      {
        role: 'user',
        content: '<**sm:off**>'
      } as any
    ]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('stopMessageClear');
  });
});
