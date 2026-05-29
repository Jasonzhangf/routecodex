import type {
  RoutingInstructionState,
  StoplessGoalStateSnapshot
} from '../../router/virtual-router/routing-instructions.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../router/virtual-router/routing-state-store.js';
import {
  applyStoplessGoalDirectiveWithNative,
  parseRccFenceDocumentWithNative,
  type RccDirective,
  type RccFenceDocument
} from '../../router/virtual-router/engine-selection/native-rcc-fence-semantics.js';
import { resolveServertoolPersistentScopeKey } from '../state-scope.js';

type StoplessGoalStateSyncResult = {
  stickyKey: string;
  hadDirective: boolean;
  directiveTypes: string[];
  state?: StoplessGoalStateSnapshot;
  rewrittenLatestUserText?: string;
};

type StoplessGoalStateReadResult = {
  stickyKey: string;
  state?: StoplessGoalStateSnapshot;
};

type StoplessGoalStatePersistResult = {
  stickyKey: string;
  state: StoplessGoalStateSnapshot;
};

type TextHolder = {
  text: string;
  setText: (next: string) => void;
};

type LegacyReasoningStopRoutingState = RoutingInstructionState & {
  reasoningStopMode?: 'on' | 'off' | 'endless';
  reasoningStopArmed?: boolean;
  reasoningStopSummary?: string;
  reasoningStopUpdatedAt?: number;
  reasoningStopFailCount?: number;
  reasoningStopGuardTriggerCount?: number;
  reasoningStopGuardTriggerAt?: number;
};

const RCC_FENCE_OPEN = '<**rcc**>';
const STOPLESS_GOAL_RUNTIME_SCOPE_REQUIRED = 'STOPLESS_GOAL_RUNTIME_SCOPE_REQUIRED';

function createEmptyRoutingInstructionState(): LegacyReasoningStopRoutingState {
  return {
    stoplessGoalState: undefined,
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    reasoningStopMode: undefined,
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    reasoningStopFailCount: undefined,
    reasoningStopGuardTriggerCount: undefined,
    reasoningStopGuardTriggerAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStoplessGoalStatus(value: unknown): value is StoplessGoalStateSnapshot['status'] {
  return value === 'idle' || value === 'active' || value === 'paused' || value === 'stopped' || value === 'completed';
}

function isStoplessGoalStateSnapshot(value: unknown): value is StoplessGoalStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isStoplessGoalStatus(record.status) &&
    typeof record.objective === 'string' &&
    isFiniteNumber(record.updatedAt) &&
    isFiniteNumber(record.createdAt)
  );
}

function contentContainsRccFence(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.includes(RCC_FENCE_OPEN);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((entry) => {
    if (typeof entry === 'string') {
      return entry.includes(RCC_FENCE_OPEN);
    }
    const record = asRecord(entry);
    return typeof record?.text === 'string' && record.text.includes(RCC_FENCE_OPEN);
  });
}

function findTextHolderInContent(content: unknown): TextHolder | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const textualEntries: Array<{ getText: () => string; setText: (next: string) => void }> = [];
  for (let index = 0; index < content.length; index += 1) {
    const entry = content[index];
    if (typeof entry === 'string') {
      textualEntries.push({
        getText: () => normalizeText(content[index]),
        setText: (next: string) => {
          content[index] = next;
        }
      });
      continue;
    }
    const record = asRecord(entry);
    if (!record || typeof record.text !== 'string') {
      continue;
    }
    textualEntries.push({
      getText: () => normalizeText(record.text),
      setText: (next: string) => {
        record.text = next;
      }
    });
  }

  if (textualEntries.length === 0) {
    return null;
  }
  const holdersWithFence = textualEntries.filter((entry) => entry.getText().includes(RCC_FENCE_OPEN));
  if (holdersWithFence.length > 1) {
    const holder = holdersWithFence[0];
    return {
      text: holder.getText(),
      setText(next: string) {
        holder.setText(next);
        for (const entry of holdersWithFence.slice(1)) {
          entry.setText('');
        }
      }
    };
  }
  const holder = holdersWithFence[0] ?? textualEntries[textualEntries.length - 1];
  return {
    text: holder.getText(),
    setText: holder.setText
  };
}

function findLatestUserTextHolder(source: unknown): TextHolder | null {
  const record = asRecord(source);
  if (!record) {
    return null;
  }

  if (typeof record.input === 'string' && record.input.trim()) {
    return {
      text: record.input,
      setText(next: string) {
        record.input = next;
      }
    };
  }

  const rows = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : [];

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = asRecord(rows[index]);
    if (!row) {
      continue;
    }
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    if (!contentContainsRccFence(row.content)) {
      continue;
    }
    if (typeof row.content === 'string') {
      return {
        text: row.content,
        setText(next: string) {
          row.content = next;
        }
      };
    }
    return findTextHolderInContent(row.content);
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = asRecord(rows[index]);
    if (!row) {
      continue;
    }
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    if (typeof row.content === 'string') {
      return {
        text: row.content,
        setText(next: string) {
          row.content = next;
        }
      };
    }
    return findTextHolderInContent(row.content);
  }

  return null;
}

function compactRewrittenText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function consumeStoplessDirectivesFromText(
  text: string,
  document: RccFenceDocument
): {
  rewrittenText: string;
  directiveTypes: string[];
  stoplessDirectives: RccDirective[];
} {
  if (!text || document.blocks.length === 0 || document.blocks.length !== document.directives.length) {
    return {
      rewrittenText: text,
      directiveTypes: [],
      stoplessDirectives: []
    };
  }

  const out: string[] = [];
  const directiveTypes: string[] = [];
  const stoplessDirectives: RccDirective[] = [];
  let cursor = 0;

  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index];
    const directive = document.directives[index];
    out.push(text.slice(cursor, block.startOffset));

    if (directive.domain !== 'stopless') {
      out.push(block.raw);
      cursor = block.endOffset;
      continue;
    }

    directiveTypes.push(directive.directiveType);
    stoplessDirectives.push(directive);
    if (directive.passthrough === 'body-forward') {
      out.push(directive.body);
    }
    cursor = block.endOffset;
  }

  out.push(text.slice(cursor));
  return {
    rewrittenText: compactRewrittenText(out.join('')),
    directiveTypes,
    stoplessDirectives
  };
}

function requirePersistentStickyKey(adapterContext: unknown): string {
  const stickyKey = resolveServertoolPersistentScopeKey(adapterContext) ?? '';
  if (!stickyKey) {
    throw new Error(STOPLESS_GOAL_RUNTIME_SCOPE_REQUIRED);
  }
  return stickyKey;
}

function applyGoalStateToAdapterRecord(args: {
  record: Record<string, unknown>;
  state?: StoplessGoalStateSnapshot;
  hadDirective: boolean;
  directiveTypes: string[];
}): void {
  if (args.state) {
    args.record.stoplessGoalState = args.state;
  }
  if (args.directiveTypes.length > 0) {
    args.record.stoplessGoalDirectiveTypes = args.directiveTypes;
  }
  const rt = (asRecord(args.record.__rt) ?? {}) as Record<string, unknown>;
  args.record.__rt = {
    ...rt,
    ...(args.hadDirective ? { stoplessGoalHadDirective: true } : {}),
    stoplessGoalStateSource: args.hadDirective ? 'directive' : 'persisted',
    ...(args.state?.status ? { stoplessGoalStatus: args.state.status } : {}),
    ...(args.directiveTypes.length > 0 ? { stoplessGoalDirectiveTypes: args.directiveTypes } : {})
  };
}

export function readStoplessGoalState(adapterContext: unknown): StoplessGoalStateReadResult {
  const direct = asRecord(adapterContext);
  const directState = direct?.stoplessGoalState;
  const stickyKey = resolveServertoolPersistentScopeKey(adapterContext) ?? '';
  if (isStoplessGoalStateSnapshot(directState)) {
    return {
      stickyKey,
      state: directState
    };
  }
  if (!stickyKey) {
    return { stickyKey: '' };
  }
  const persisted = loadRoutingInstructionStateSync(stickyKey);
  if (!isStoplessGoalStateSnapshot(persisted?.stoplessGoalState)) {
    return { stickyKey };
  }
  return {
    stickyKey,
    state: persisted.stoplessGoalState
  };
}

export function hasManagedStoplessGoalState(adapterContext: unknown): boolean {
  const state = readStoplessGoalState(adapterContext).state;
  return Boolean(state && state.status !== 'idle');
}

export function isStoplessGoalActive(adapterContext: unknown): boolean {
  return readStoplessGoalState(adapterContext).state?.status === 'active';
}

export function persistStoplessGoalStateSnapshot(
  adapterContext: unknown,
  state: StoplessGoalStateSnapshot
): StoplessGoalStatePersistResult {
  const record = asRecord(adapterContext);
  const stickyKey = requirePersistentStickyKey(adapterContext);
  const currentState =
    (loadRoutingInstructionStateSync(stickyKey) as LegacyReasoningStopRoutingState | null)
    ?? createEmptyRoutingInstructionState();
  currentState.stoplessGoalState = state;
  saveRoutingInstructionStateSync(stickyKey, currentState);
  if (record) {
    applyGoalStateToAdapterRecord({
      record,
      state,
      hadDirective: false,
      directiveTypes: []
    });
  }
  return {
    stickyKey,
    state
  };
}

export function syncStoplessGoalStateFromRequest(adapterContext: unknown): StoplessGoalStateSyncResult {
  const record = asRecord(adapterContext);
  if (!record) {
    return {
      stickyKey: '',
      hadDirective: false,
      directiveTypes: []
    };
  }

  const stickyKey = resolveServertoolPersistentScopeKey(adapterContext) ?? '';
  const persistedGoalState = stickyKey
    ? readStoplessGoalState(adapterContext).state
    : undefined;
  const textHolder = findLatestUserTextHolder(record.capturedChatRequest);
  const latestUserText = normalizeText(textHolder?.text);
  if (!latestUserText.includes(RCC_FENCE_OPEN)) {
    if (persistedGoalState) {
      applyGoalStateToAdapterRecord({
        record,
        state: persistedGoalState,
        hadDirective: false,
        directiveTypes: []
      });
    }
    return {
      stickyKey,
      hadDirective: false,
      directiveTypes: [],
      ...(persistedGoalState ? { state: persistedGoalState } : {})
    };
  }

  const persistedStickyKey = requirePersistentStickyKey(adapterContext);
  const parsed = parseRccFenceDocumentWithNative(latestUserText);
  const consumed = consumeStoplessDirectivesFromText(latestUserText, parsed);
  if (consumed.stoplessDirectives.length === 0) {
    if (persistedGoalState) {
      applyGoalStateToAdapterRecord({
        record,
        state: persistedGoalState,
        hadDirective: false,
        directiveTypes: []
      });
    }
    return {
      stickyKey: persistedStickyKey,
      hadDirective: false,
      directiveTypes: [],
      ...(persistedGoalState ? { state: persistedGoalState } : {})
    };
  }

  let currentState =
    (loadRoutingInstructionStateSync(persistedStickyKey) as LegacyReasoningStopRoutingState | null)
    ?? createEmptyRoutingInstructionState();
  let nextGoalState = currentState.stoplessGoalState;
  const nowMs = Date.now();
  for (const directive of consumed.stoplessDirectives) {
    nextGoalState = applyStoplessGoalDirectiveWithNative({
      currentState: nextGoalState,
      directive,
      nowMs
    });
  }

  currentState.stoplessGoalState = nextGoalState;
  currentState.reasoningStopMode = undefined;
  currentState.reasoningStopArmed = undefined;
  currentState.reasoningStopSummary = undefined;
  currentState.reasoningStopUpdatedAt = undefined;
  currentState.reasoningStopFailCount = undefined;
  currentState.reasoningStopGuardTriggerCount = undefined;
  currentState.reasoningStopGuardTriggerAt = undefined;
  saveRoutingInstructionStateSync(persistedStickyKey, currentState);

  if (textHolder) {
    textHolder.setText(consumed.rewrittenText);
  }

  applyGoalStateToAdapterRecord({
    record,
    state: nextGoalState,
    hadDirective: true,
    directiveTypes: consumed.directiveTypes
  });

  return {
    stickyKey: persistedStickyKey,
    hadDirective: true,
    directiveTypes: consumed.directiveTypes,
    ...(nextGoalState ? { state: nextGoalState } : {}),
    ...(consumed.rewrittenText ? { rewrittenLatestUserText: consumed.rewrittenText } : {})
  };
}
