import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  serializeRoutingInstructionState,
  deserializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts';
import {
  applyRoutingInstructionsWithNative,
  parseRoutingInstructions
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-instructions-semantics.ts';

type StandardizedMessage = Record<string, unknown> & {
  role: string;
  content: string;
};

function createState(): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined
  };
}

function applyRoutingInstructions(
  instructions: Array<Record<string, unknown>>,
  state: RoutingInstructionState
): RoutingInstructionState {
  return deserializeRoutingInstructionState(
    applyRoutingInstructionsWithNative({
      instructions,
      state: serializeRoutingInstructionState(state)
    })
  );
}

function extractStopMessageMarker(content: string): string | null {
  const start = content.indexOf('<**stopMessage');
  if (start < 0) return null;
  const end = content.indexOf('**>', start);
  if (end < 0) return null;
  return content.slice(start, end + 3);
}

function findStopMessageSampleMarker(samplesRoot: string): { file: string; marker: string } | null {
  if (!fs.existsSync(samplesRoot)) return null;
  const providers = fs.readdirSync(samplesRoot).filter((name) => name !== '__pending__');
  const fileCandidates = [
    'client-request.json',
    'chat_process.req.stage1.format_parse.json',
    'chat_process.req.stage2.semantic_map.json'
  ];
  let checked = 0;
  const maxChecks = 200;
  for (const provider of providers) {
    const providerDir = path.join(samplesRoot, provider);
    if (!fs.statSync(providerDir).isDirectory()) continue;
    const requests = fs.readdirSync(providerDir).filter((name) => name.startsWith('req_'));
    for (const req of requests) {
      const reqDir = path.join(providerDir, req);
      if (!fs.statSync(reqDir).isDirectory()) continue;
      for (const fileName of fileCandidates) {
        const filePath = path.join(reqDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        checked += 1;
        if (checked > maxChecks) return null;
        const content = fs.readFileSync(filePath, 'utf8');
        const marker = extractStopMessageMarker(content);
        if (marker) return { file: filePath, marker };
      }
    }
  }
  return null;
}

function readJsonFile(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(relativePath, 'utf8')) as Record<string, unknown>;
}

function collectToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return '';
      const record = tool as Record<string, unknown>;
      if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
      const functionRecord = record.function && typeof record.function === 'object' && !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : undefined;
      if (typeof functionRecord?.name === 'string' && functionRecord.name.trim()) return functionRecord.name.trim();
      if (typeof record.type === 'string' && record.type.trim()) return record.type.trim();
      return '';
    })
    .filter(Boolean);
}

describe('stopMessage sample replay', () => {
  const samplesRoot = path.join(process.env.HOME || '', '.rcc', 'codex-samples', 'openai-responses');
  const sample = findStopMessageSampleMarker(samplesRoot) ?? { file: '', marker: '' };
  const currentSampleDirs = fs.existsSync(path.join(samplesRoot, 'port-5555'))
    ? fs.readdirSync(path.join(samplesRoot, 'port-5555'))
        .filter((name) => name.startsWith('req_'))
        .slice(0, 2)
        .map((name) => path.join(samplesRoot, 'port-5555', name))
    : [];

  test('parses stopMessage marker from codex-samples replay', () => {
    if (!sample.file) {
      return;
    }
    const messages: StandardizedMessage[] = [
      { role: 'user', content: `${sample.marker} continue` }
    ];
    const instructions = parseRoutingInstructions(messages);
    expect(instructions.length).toBeGreaterThan(0);
    const stopInst = instructions.find((inst) => String((inst as any).type).startsWith('stopMessage'));
    expect(stopInst).toBeTruthy();

    const nextState = applyRoutingInstructions(instructions, createState());
    if ((stopInst as any)?.type === 'stopMessageSet') {
      expect(nextState.stopMessageText).toBeTruthy();
      expect(typeof nextState.stopMessageMaxRepeats).toBe('number');
    } else if ((stopInst as any)?.type === 'stopMessageMode') {
      expect(nextState.stopMessageText).toBeUndefined();
    } else if ((stopInst as any)?.type === 'stopMessageClear') {
      expect(nextState.stopMessageText).toBeUndefined();
    }
  });

  test('preserves current provider-facing stopless tool shape in codex-samples replay', () => {
    expect(currentSampleDirs.length).toBeGreaterThanOrEqual(1);
    for (const dir of currentSampleDirs) {
      const request = readJsonFile(path.join(dir, 'provider-request.json'));
      const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const toolNames = collectToolNames(tools);
      const toolNameSet = new Set(toolNames);
      expect(tools.length).toBe(1);
      expect(toolNameSet).toEqual(new Set(['reasoningStop']));
      const digest = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
      expect(digest).toHaveLength(64);
    }
  });

  test('codex-samples replay keeps current stopless scope materialization stable when session metadata is absent', () => {
    const sampleDir = currentSampleDirs[0];
    expect(sampleDir).toBeTruthy();
    const runtime = readJsonFile(path.join(sampleDir, '__runtime.json'));
    const request = readJsonFile(path.join(sampleDir, 'provider-request.json'));
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
    const sessionId = typeof request.session === 'string' && request.session.trim()
      ? request.session.trim()
      : typeof request.meta === 'object' && request.meta && !Array.isArray(request.meta) && typeof (request.meta as Record<string, unknown>).sessionId === 'string'
        ? String((request.meta as Record<string, unknown>).sessionId).trim()
        : '';
    const conversationId = typeof request.conversation === 'string' && request.conversation.trim()
      ? request.conversation.trim()
      : typeof request.meta === 'object' && request.meta && !Array.isArray(request.meta) && typeof (request.meta as Record<string, unknown>).conversationId === 'string'
        ? String((request.meta as Record<string, unknown>).conversationId).trim()
        : '';
    expect(sessionId).toBe('');
    expect(conversationId).toBe('');
    expect(Array.isArray(body.tools) ? body.tools.length : 0).toBe(1);
    expect(runtime).toBeTruthy();
  });
});
