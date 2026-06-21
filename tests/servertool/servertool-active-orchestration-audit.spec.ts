import fs from 'node:fs';
import path from 'node:path';

const TARGETS = [
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts',
    forbidden: [
      'const SERVERTOOL_BACKEND_EXECUTORS',
      'const servertoolBackendExecutors',
      'const materializePlannedServertoolResult',
      'const executeBackendPlanViaThinShell',
      'const runServertoolHandlerThinShell',
      'function materializeServertoolPlannedResult(',
      'function executeServertoolBackendPlan(',
      'export async function runServertoolHandler(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
    forbidden: [
      'const buildDispatchPlanInputViaThinShell',
      'const buildOutcomePlanInputViaThinShell',
      'const resolveToolCallExecutionOutcomeViaThinShell',
      'const runToolCallExecutionLoopViaThinShell',
      'const resolveHandlerExecutionSpecViaThinShell',
      'function buildServertoolDispatchPlanInputThinShell(',
      'function buildServertoolOutcomePlanInputThinShell(',
      'function resolveToolCallExecutionOutcomeThinShell(',
      'function runToolCallExecutionLoopThinShell(',
      'export function resolveServertoolHandlerExecutionSpec(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts',
    forbidden: [
      "import './handlers/stop-message-auto.js';",
      "import './handlers/vision.js';",
      'export async function runServerSideToolEngineImpl(',
      'export function extractToolCallsImpl(',
      'export function collectAdditionalClientToolCallsImpl(',
      'const gatePlan = planServertoolResponseStageGateWithNative(',
      'return await runServertoolAutoHookCallerImpl(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine.ts',
    forbidden: [
      'function extractStoplessReasoningText(',
      'function extractStoplessLoopState(',
      'function readStoplessRouteName(',
      'function isDirectStoplessDisabled(',
      'const loopState = extractStoplessLoopState(',
      'reasoningText: extractStoplessReasoningText(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/registry-impl.ts',
    forbidden: [
      'const toolHandlerRegistryImpl',
      'const autoHandlerRegistryImpl',
      'let autoHookOrderImpl = 0',
      'export function registerServerToolHandlerImpl(',
      'export function getServerToolHandlerImpl(',
      'export function listAutoHandlersForRegistryImpl(',
      'export function collectAutoServerToolHooksImpl(',
    ],
  },
] as const;

function repoPath(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

describe('servertool active orchestration audit', () => {
  for (const target of TARGETS) {
    test(`${target.file} must not retain active orchestration owner markers`, () => {
      const source = fs.readFileSync(repoPath(target.file), 'utf8');
      const hits = target.forbidden.filter((marker) => source.includes(marker));
      expect(hits).toEqual([]);
    });
  }
});
