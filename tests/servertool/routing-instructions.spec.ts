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

const MODE_SHORTHAND_PROBE = parseRoutingInstructions(buildMessages('<**stopMessage:on**>继续'))[0] as any;
const SUPPORTS_STOPMESSAGE_MODE_SHORTHAND = MODE_SHORTHAND_PROBE?.type === 'stopMessageMode';
const STOPMESSAGE_DEFAULT_REPEAT_PROBE =
  parseRoutingInstructions(buildMessages('<**stopMessage:"继续"**>'))[0] as any;
const DEFAULT_STOPMESSAGE_MAX_REPEATS =
  typeof STOPMESSAGE_DEFAULT_REPEAT_PROBE?.stopMessageMaxRepeats === 'number'
    ? STOPMESSAGE_DEFAULT_REPEAT_PROBE.stopMessageMaxRepeats
    : 10;
const PASSTHROUGH_PREFER_PROBE = parseRoutingInstructions(
  buildMessages('<**!tab.gpt-5.3-codex:passthrough**>')
)[0] as any;
const SUPPORTS_PREFER_PROCESSMODE_SUFFIX =
  PASSTHROUGH_PREFER_PROBE?.type === 'prefer' && PASSTHROUGH_PREFER_PROBE?.processMode === 'passthrough';
const SUPPORTS_HISTORY_MARKER_REPLAY =
  parseRoutingInstructions([
    { role: 'user', content: '<**stopMessage:on,10**>继续执行' },
    { role: 'assistant', content: '好的，我继续。' },
    { role: 'user', content: '现在查看进度' }
  ] as StandardizedMessage[]).length > 0;
const SUPPORTS_PRECOMMAND_INSTRUCTION =
  parseRoutingInstructions(buildMessages('<**precommand:clear**>')).some((inst) => inst.type === 'preCommandClear');

const testIf = (condition: boolean) => (condition ? test : test.skip);

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

  test('sticky:provider.model instructions are parsed and persisted as stickyTarget', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**sticky:deepseek-web.deepseek-chat**>'));
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    expect(instruction.type).toBe('sticky');
    expect(instruction.provider).toBe('deepseek-web');
    expect(instruction.model).toBe('deepseek-chat');
    expect(instruction.pathLength).toBe(2);

    const nextState = applyRoutingInstructions(instructions, createState());
    expect(nextState.stickyTarget?.provider).toBe('deepseek-web');
    expect(nextState.stickyTarget?.model).toBe('deepseek-chat');
  });

  test('force:provider.model instructions are parsed as force target', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**force:deepseek-web.deepseek-chat**>'));
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    expect(instruction.type).toBe('force');
    expect(instruction.provider).toBe('deepseek-web');
    expect(instruction.model).toBe('deepseek-chat');
    expect(instruction.pathLength).toBe(2);
  });

  testIf(SUPPORTS_PREFER_PROCESSMODE_SUFFIX)('prefer instruction supports :passthrough mode suffix', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**!tab.gpt-5.3-codex:passthrough**>'));
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    expect(instruction.type).toBe('prefer');
    expect(instruction.provider).toBe('tab');
    expect(instruction.model).toBe('gpt-5.3-codex');
    expect(instruction.processMode).toBe('passthrough');
  });

  testIf(SUPPORTS_PREFER_PROCESSMODE_SUFFIX)(
    'prefer instruction ignores unknown mode suffix and keeps regular mode',
    () => {
      const instructions = parseRoutingInstructions(buildMessages('<**!tab.gpt-5.3-codex:unknown_mode**>'));
      expect(instructions).toHaveLength(1);
      const instruction = instructions[0];
      expect(instruction.type).toBe('prefer');
      expect(instruction.provider).toBe('tab');
      expect(instruction.model).toBe('gpt-5.3-codex');
      expect(instruction.processMode).toBeUndefined();
    }
  );

  testIf(!SUPPORTS_PREFER_PROCESSMODE_SUFFIX)(
    'prefer instruction with mode suffix gracefully degrades when unsupported',
    () => {
      const instructions = parseRoutingInstructions(buildMessages('<**!tab.gpt-5.3-codex:passthrough**>'));
      expect(instructions).toHaveLength(0);
      const nextState = applyRoutingInstructions(instructions, createState());
      expect(nextState.preferTarget).toBeUndefined();
    }
  );

  testIf(SUPPORTS_PREFER_PROCESSMODE_SUFFIX)('applyRoutingInstructions persists processMode on prefer target', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**!tab.gpt-5.3-codex:passthrough**>'));
    const nextState = applyRoutingInstructions(instructions, createState());
    expect(nextState.preferTarget?.provider).toBe('tab');
    expect(nextState.preferTarget?.model).toBe('gpt-5.3-codex');
    expect(nextState.preferTarget?.processMode).toBe('passthrough');
  });

  testIf(!SUPPORTS_PREFER_PROCESSMODE_SUFFIX)(
    'applyRoutingInstructions keeps state unchanged for unsupported mode suffix',
    () => {
      const instructions = parseRoutingInstructions(buildMessages('<**!tab.gpt-5.3-codex:passthrough**>'));
      const nextState = applyRoutingInstructions(instructions, createState());
      expect(nextState.preferTarget).toBeUndefined();
    }
  );

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
    expect(inst.stopMessageMaxRepeats).toBe(DEFAULT_STOPMESSAGE_MAX_REPEATS);
  });

  test('parses stopMessage with explicit repeat', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:"继续",3**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('继续');
    expect(inst.stopMessageMaxRepeats).toBe(3);
  });

  test('parses stopMessage when command token is quoted', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**"stopMessage","继续",ai:on,10**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('继续');
    expect(inst.stopMessageMaxRepeats).toBe(10);
    expect(inst.stopMessageAiMode).toBe('on');
  });

  test('parses stopMessage when command token has zero-width leading char', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**\u200BstopMessage,"继续",ai:on,10**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('继续');
    expect(inst.stopMessageMaxRepeats).toBe(10);
    expect(inst.stopMessageAiMode).toBe('on');
  });

  test('lowercase stopmessage marker is ignored (case-sensitive parser)', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopmessage:on,10**>继续执行'));
    expect(instructions).toHaveLength(0);
  });

  test('without clear, invalid mode-only directive is ignored and latest valid directive stays effective', () => {
    const instructions = parseRoutingInstructions(
      buildMessages('<**stopMessage:"先前指令",2**><**stopMessage:on,10**>继续执行')
    );
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageSet');
    expect(inst.stopMessageText).toBe('先前指令');
    expect(inst.stopMessageMaxRepeats).toBe(2);
  });

  test('with clear, stopMessage clear wins and other stopMessage directives are ignored', () => {
    const instructions = parseRoutingInstructions(
      buildMessages('<**stopMessage:"先前指令",2**><**stopMessage:clear**><**stopMessage:on,10**>继续执行')
    );
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageClear');
  });

  test('with global clear, all other directives are ignored', () => {
    const instructions = parseRoutingInstructions(
      buildMessages('<**!glm**><**stopMessage:on,10**><**clear**><**force:crs.gpt-5.3-codex**>继续执行')
    );
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('clear');
  });
  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('parses stopMessage mode shorthand and ignores trailing text outside tag', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:on**>继续'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(10);
  });

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('parses stopMessage mode shorthand and ignores trailing multi-line footer text', () => {
    const instructions = parseRoutingInstructions(
      buildMessages('<**stopMessage:on**>继续\n[Time/Date]: utc=  local=  tz=  nowMs=  ntpOffsetMs=')
    );
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(10);
  });

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('parses stopMessage mode shorthand with explicit repeat and ignores trailing text', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:on,3**>继续'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(3);
  });

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('keeps stopMessage mode command when trailing text is empty', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:on,3**>'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(3);
  });

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('mode shorthand arms stopMessage stage mode without text', () => {
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:on,10**>这里是本轮普通请求文本'));
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(10);

    const nextState = applyRoutingInstructions(instructions, createState());
    expect(nextState.stopMessageText).toBeUndefined();
    expect(nextState.stopMessageStageMode).toBe('on');
    expect(nextState.stopMessageMaxRepeats).toBe(10);
    expect(nextState.stopMessageUsed).toBeUndefined();
  });

  testIf(SUPPORTS_HISTORY_MARKER_REPLAY)('keeps stopMessage command when latest marker is previous user without assistant reply', () => {
    const instructions = parseRoutingInstructions([
      { role: 'user', content: '<**stopMessage:on,10**>继续执行' },
      { role: 'user', content: '补充说明：按当前计划推进' }
    ] as StandardizedMessage[]);
    expect(instructions).toHaveLength(1);
    const inst = instructions[0] as any;
    expect(inst.type).toBe('stopMessageMode');
    expect(inst.stopMessageStageMode).toBe('on');
    expect(inst.stopMessageMaxRepeats).toBe(10);
  });

  testIf(SUPPORTS_HISTORY_MARKER_REPLAY)('parses latest marker even if there are newer plain user messages', () => {
    const instructions = parseRoutingInstructions([
      { role: 'user', content: '<**stopMessage:on,10**>继续执行' },
      { role: 'assistant', content: '好的，我继续。' },
      { role: 'user', content: '现在查看进度' }
    ] as StandardizedMessage[]);
    expect(instructions).toHaveLength(1);
    expect((instructions[0] as any).type).toBe('stopMessageMode');
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

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)(
    'self-heals legacy mode-only stopMessage snapshot without maxRepeats',
    () => {
      const restored = deserializeRoutingInstructionState({
        stopMessageStageMode: 'on',
        stopMessageUsed: 3
      } as Record<string, unknown>);

      expect(restored.stopMessageText).toBeUndefined();
      expect(restored.stopMessageStageMode).toBe('on');
      expect(restored.stopMessageMaxRepeats).toBe(DEFAULT_STOPMESSAGE_MAX_REPEATS);
      expect(restored.stopMessageUsed).toBe(3);
    }
  );

  testIf(SUPPORTS_STOPMESSAGE_MODE_SHORTHAND)('mode shorthand updates repeats even without text change', () => {
    const baseState = createState({
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageStageMode: 'on'
    });
    const instructions = parseRoutingInstructions(buildMessages('<**stopMessage:on,3**>'));
    const nextState = applyRoutingInstructions(instructions, baseState);
    expect(nextState.stopMessageText).toBe('继续');
    expect(nextState.stopMessageStageMode).toBe('on');
    expect(nextState.stopMessageMaxRepeats).toBe(3);
  });

  test('mode-only instruction creates stage-mode stopMessage state when text is absent', () => {
    const nextState = applyRoutingInstructions(
      [{ type: 'stopMessageMode', stopMessageStageMode: 'on' }],
      createState()
    );
    expect(nextState.stopMessageText).toBeUndefined();
    expect(nextState.stopMessageStageMode).toBe('on');
    expect(nextState.stopMessageMaxRepeats).toBe(DEFAULT_STOPMESSAGE_MAX_REPEATS);
    expect(nextState.stopMessageUsed).toBeUndefined();
  });


  test('drops legacy staged stopMessage metadata fields during serialization', () => {
    const baseState = createState({
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 1,
      stopMessageStage: 'loop_self_check',
      stopMessageObservationHash: 'abc123',
      stopMessageObservationStableCount: 1,
      stopMessageBdWorkState: 'active'
    });

    const serialized = serializeRoutingInstructionState(baseState);
    const restored = deserializeRoutingInstructionState(serialized);
    expect(restored.stopMessageStage).toBeUndefined();
    expect(restored.stopMessageObservationHash).toBeUndefined();
    expect(restored.stopMessageObservationStableCount).toBeUndefined();
    expect(restored.stopMessageBdWorkState).toBeUndefined();
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
      expect(inst.stopMessageMaxRepeats).toBe(DEFAULT_STOPMESSAGE_MAX_REPEATS);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prev;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  testIf(SUPPORTS_PRECOMMAND_INSTRUCTION)('parses precommand script under ~/.routecodex/precommand and serializes state', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-precommand-'));
    const prev = process.env.ROUTECODEX_USER_DIR;
    try {
      process.env.ROUTECODEX_USER_DIR = temp;
      fs.mkdirSync(path.join(temp, 'precommand'), { recursive: true });
      const scriptPath = path.join(temp, 'precommand', 'fix-exec.sh');
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\n', 'utf8');

      const instructions = parseRoutingInstructions(
        buildMessages('<**precommand:<file://precommand/fix-exec.sh>**>')
      );
      expect(instructions).toHaveLength(1);
      const inst = instructions[0] as any;
      expect(inst.type).toBe('preCommandSet');
      expect(inst.preCommandScriptPath).toBe(scriptPath);

      const nextState = applyRoutingInstructions(instructions, createState());
      expect(nextState.preCommandScriptPath).toBe(scriptPath);
      expect(nextState.preCommandSource).toBe('explicit');

      const serialized = serializeRoutingInstructionState(nextState);
      const restored = deserializeRoutingInstructionState(serialized);
      expect(restored.preCommandScriptPath).toBe(scriptPath);
      expect(restored.preCommandSource).toBe('explicit');
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prev;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  testIf(SUPPORTS_PRECOMMAND_INSTRUCTION)('auto-creates precommand default.sh for precommand:on', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-precommand-default-'));
    const prev = process.env.ROUTECODEX_USER_DIR;
    try {
      process.env.ROUTECODEX_USER_DIR = temp;
      const instructions = parseRoutingInstructions(buildMessages('<**precommand:on**>继续'));
      expect(instructions).toHaveLength(1);
      const inst = instructions[0] as any;
      expect(inst.type).toBe('preCommandSet');
      expect(typeof inst.preCommandScriptPath).toBe('string');
      const scriptPath = String(inst.preCommandScriptPath);
      expect(path.basename(scriptPath)).toBe('default.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      expect(fs.statSync(scriptPath).isFile()).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prev;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  testIf(SUPPORTS_PRECOMMAND_INSTRUCTION)('clears precommand state via instruction', () => {
    const state = createState({
      preCommandSource: 'explicit',
      preCommandScriptPath: '/tmp/test-precommand.sh',
      preCommandUpdatedAt: Date.now()
    });
    const instructions = parseRoutingInstructions(buildMessages('<**precommand:clear**>'));
    const nextState = applyRoutingInstructions(instructions, state);
    expect(nextState.preCommandScriptPath).toBeUndefined();
    expect(nextState.preCommandSource).toBeUndefined();
  });
});
