import type { StandardizedMessage } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import {
  parseRoutingInstructions,
  applyRoutingInstructions,
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
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
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

  test('sticky provider.model instructions keep model target without alias binding', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**!antigravity.claude-sonnet-4-5**>'));
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    expect(instruction.type).toBe('sticky');
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

  test('enable instructions remove provider model bans', () => {
    const initialState = createState({
      disabledModels: new Map([['glm', new Set(['gpt-4', 'glm-4.7'])]])
    });
    const instructions = parseRoutingInstructions(buildMessages('<**@glm.gpt-4**>'));
    const nextState = applyRoutingInstructions(instructions, initialState);
    const models = nextState.disabledModels.get('glm');
    expect(Array.from(models ?? [])).toEqual(['glm-4.7']);
  });
});
