import type { StandardizedMessage } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import {
  parseRoutingInstructions,
  applyRoutingInstructions,
  serializeRoutingInstructionState,
  deserializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

function buildMessages(content: string): StandardizedMessage[] {
  return [
    {
      role: 'user',
      content
    }
  ];
}

function createState(overrides?: Partial<RoutingInstructionState>): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    ...(overrides ?? {})
  };
}

describe('Routing instruction parsing and application', () => {
  test('splits comma separated allow instructions', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**!glm,openai**>'));
    expect(instructions).toHaveLength(2);
    expect(instructions.map((inst) => inst.type)).toEqual(['allow', 'allow']);
    expect(instructions.map((inst) => inst.provider)).toEqual(['glm', 'openai']);
  });

  test('allow instructions override previous whitelist', () => {
    const initialState = createState({
      allowedProviders: new Set(['anthropic'])
    });
    const instructions = parseRoutingInstructions(buildMessages('<**!glm,openai**>'));
    const nextState = applyRoutingInstructions(instructions, initialState);
    expect(Array.from(nextState.allowedProviders).sort()).toEqual(['glm', 'openai']);
  });

  test('prefer provider.model instructions keep model target without alias binding', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**!antigravity.claude-sonnet-4-5**>'));
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    expect(instruction.type).toBe('prefer');
    expect(instruction.provider).toBe('antigravity');
    expect(instruction.model).toBe('claude-sonnet-4-5');
    expect(instruction.keyAlias).toBeUndefined();
    expect(instruction.pathLength).toBe(2);
  });

  test('disable instructions override previous blacklist entries', () => {
    const initialState = createState({
      disabledProviders: new Set(['anthropic']),
      disabledKeys: new Map([['openai', new Set<string | number>(['primary'])]])
    });
    const instructions = parseRoutingInstructions(buildMessages('<**#glm,openai.1**>'));
    const nextState = applyRoutingInstructions(instructions, initialState);
    expect(Array.from(nextState.disabledProviders)).toEqual(['glm']);
    const openaiKeys = nextState.disabledKeys.get('openai');
    expect(openaiKeys).toBeDefined();
    expect(Array.from(openaiKeys ?? []).sort()).toEqual([1]);
  });

  test('disable instructions can target provider models', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**#glm.gpt-4**>'));
    const nextState = applyRoutingInstructions(instructions, createState());
    const models = nextState.disabledModels.get('glm');
    expect(models).toBeDefined();
    expect(Array.from(models ?? [])).toEqual(['gpt-4']);
  });

  test('bare provider instructions act as provider whitelist', () => {
    const initialState = createState({
      allowedProviders: new Set(['openai', 'glm'])
    });
    const instructions = parseRoutingInstructions(buildMessages('<**antigravity**>'));
    expect(instructions).toHaveLength(1);
    expect(instructions[0].type).toBe('allow');
    expect(instructions[0].provider).toBe('antigravity');

    const nextState = applyRoutingInstructions(instructions, initialState);
    expect(Array.from(nextState.allowedProviders)).toEqual(['antigravity']);
  });

  test('enable instructions remove provider model bans', () => {
    const initialState = createState({
      disabledModels: new Map([['glm', new Set(['gpt-4', 'glm-4.7'])]])
    });
    const instructions = parseRoutingInstructions(buildMessages('<**@glm.gpt-4**>'));
    const nextState = applyRoutingInstructions(instructions, initialState);
    const models = nextState.disabledModels.get('glm');
    expect(Array.from(models ?? [])).toEqual(['glm-4.7']);
  });

  test('parses stopMessage with default repeat', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:"继续"**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('继续');
    expect(inst.stopMessageMaxRepeats).toBe(10);
  });

  test('parses stopMessage with explicit repeat', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:"继续",3**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('继续');
    expect(inst.stopMessageMaxRepeats).toBe(3);
  });

  test('applies and serializes stopMessage state', () => {
    const baseState = createState();
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:"继续",2**>'));
    const nextState = applyRoutingInstructions(instructions, baseState);
    expect(nextState.stopMessageText).toBe('继续');
    expect(nextState.stopMessageMaxRepeats).toBe(2);
    expect(nextState.stopMessageUsed).toBe(0);

    const serialized = serializeRoutingInstructionState(nextState);
    const restored = deserializeRoutingInstructionState(serialized);
    expect(restored.stopMessageText).toBe('继续');
    expect(restored.stopMessageMaxRepeats).toBe(2);
    expect(restored.stopMessageUsed).toBe(0);
  });

  test('parses stopMessage from file:// ref (relative to ~/.routecodex)', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stopMessage-'));
    const prev = process.env.ROUTECODEX_USER_DIR;
    try {
      process.env.ROUTECODEX_USER_DIR = temp;
      fs.mkdirSync(path.join(temp, 'stopMessage'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'stopMessage', 'message1.md'), '第一行\n第二行\n', 'utf8');

      const instructions = parseRoutingInstructions(
        buildMessages('<**stopMessage:<file://stopMessage/message1.md>**>')
      );
      expect(instructions).toHaveLength(1);
      const inst = instructions[0] as any;
      expect(inst.type).toBe('stopMessageSet');
      expect(inst.stopMessageText).toContain('第一行');
      expect(inst.stopMessageText).toContain('第二行');
      expect(inst.stopMessageMaxRepeats).toBe(10);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prev;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
