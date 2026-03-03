import type { StandardizedMessage } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseRoutingInstructions,
  applyRoutingInstructions,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

function createState(): RoutingInstructionState {
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
    stopMessageUsed: undefined
  };
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

describe('stopMessage sample replay', () => {
  const samplesRoot = path.join(process.env.HOME || '', '.routecodex', 'codex-samples', 'openai-responses');
  const sample = findStopMessageSampleMarker(samplesRoot);
  if (!sample) {
    test.skip('no stopMessage marker found in codex-samples; skipping', () => {});
    return;
  }

  test('parses stopMessage marker from codex-samples replay', () => {
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
      expect(nextState.stopMessageStageMode).toBeDefined();
      expect(typeof nextState.stopMessageMaxRepeats).toBe('number');
    } else if ((stopInst as any)?.type === 'stopMessageClear') {
      expect(nextState.stopMessageText).toBeUndefined();
    }
  });
});
