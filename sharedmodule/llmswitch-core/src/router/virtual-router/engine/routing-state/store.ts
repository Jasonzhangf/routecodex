import type { RouterMetadataInput } from '../../types.js';
import type { RoutingInstructionState } from '../../routing-instructions.js';
import { mergeStopMessageFromPersisted } from '../../stop-message-state-sync.js';
import { providerErrorCenter } from '../../error-center.js';

export type RoutingInstructionStateStoreLike = {
  loadSync: (key: string) => RoutingInstructionState | null;
  saveAsync: (key: string, state: RoutingInstructionState | null) => void;
  saveSync?: (key: string, state: RoutingInstructionState | null) => void;
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function emitRoutingStateRefreshError(key: string, error: unknown): void {
  const errorMessage = formatError(error);
  providerErrorCenter.emit({
    code: 'STICKY_STATE_REFRESH_FAILED',
    message: 'failed to refresh in-memory routing state from persisted sticky store',
    stage: 'sticky_session.refresh',
    timestamp: Date.now(),
    runtime: {
      requestId: 'routing-state-store',
      providerProtocol: 'sticky-session-store',
      providerType: 'internal'
    },
    details: {
      operation: 'refresh_existing_state',
      key,
      error: errorMessage
    }
  });
  try {
    console.warn(`[routing-state-store] STICKY_STATE_REFRESH_FAILED key=${key} error=${errorMessage}`);
  } catch {
    // no-op
  }
}

function readToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed || '';
}

function isPersistentScopeKey(key: string | undefined): key is string {
  if (!key) {
    return false;
  }
  return key.startsWith('session:')
    || key.startsWith('conversation:')
    || key.startsWith('tmux:');
}

export function resolveStopMessageScope(metadata: RouterMetadataInput): string | undefined {
  const explicitScope = readToken((metadata as any)?.stopMessageClientInjectSessionScope)
    || readToken((metadata as any)?.stopMessageClientInjectScope);
  if (
    explicitScope &&
    (
      explicitScope.startsWith('tmux:')
      || explicitScope.startsWith('session:')
      || explicitScope.startsWith('conversation:')
    )
  ) {
    return explicitScope;
  }

  const tmuxSessionId = readToken((metadata as any)?.clientTmuxSessionId)
    || readToken((metadata as any)?.client_tmux_session_id)
    || readToken((metadata as any)?.tmuxSessionId)
    || readToken((metadata as any)?.tmux_session_id);
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  const sessionId = readToken((metadata as any)?.sessionId);
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const conversationId = readToken((metadata as any)?.conversationId);
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  return undefined;
}

export function getRoutingInstructionState(
  stickyKey: string | undefined,
  routingInstructionState: Map<string, RoutingInstructionState>,
  routingStateStore: RoutingInstructionStateStoreLike
): RoutingInstructionState {
  const key = stickyKey || 'default';
  const existing = routingInstructionState.get(key);

  // 对 session:/conversation:/tmux: 作用域，在每次读取时尝试从磁盘刷新 stopMessage 相关字段，
  // 确保 servertool（如 stop_message_auto）通过 sticky-session-store 更新的使用次数
  // 能在 VirtualRouter 日志中实时反映出来。
  if (existing && isPersistentScopeKey(key)) {
    try {
      const persisted = routingStateStore.loadSync(key);
      const merged = mergeStopMessageFromPersisted(existing, persisted);
      existing.stopMessageSource = merged.stopMessageSource;
      existing.stopMessageText = merged.stopMessageText;
      existing.stopMessageMaxRepeats = merged.stopMessageMaxRepeats;
      existing.stopMessageUsed = merged.stopMessageUsed;
      existing.stopMessageUpdatedAt = merged.stopMessageUpdatedAt;
      existing.stopMessageLastUsedAt = merged.stopMessageLastUsedAt;
      existing.stopMessageStageMode = merged.stopMessageStageMode;
      existing.stopMessageAiMode = merged.stopMessageAiMode;
      existing.stopMessageAiSeedPrompt = merged.stopMessageAiSeedPrompt;
      existing.stopMessageAiHistory = merged.stopMessageAiHistory;
      if (persisted) {
        existing.preCommandSource = persisted.preCommandSource;
        existing.preCommandScriptPath = persisted.preCommandScriptPath;
        existing.preCommandUpdatedAt = persisted.preCommandUpdatedAt;
      }
    } catch (error) {
      // 刷新失败不影响原有内存状态，但必须显式上报，禁止静默吞错
      emitRoutingStateRefreshError(key, error);
    }
    return existing;
  }

  let initial: RoutingInstructionState | null = null;
  // 仅对 session:/conversation:/tmux: 作用域的 key 尝试从磁盘恢复持久化状态
  if (isPersistentScopeKey(key)) {
    initial = routingStateStore.loadSync(key);
  }

  if (!initial) {
    initial = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
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
      preCommandSource: undefined,
      preCommandScriptPath: undefined,
      preCommandUpdatedAt: undefined
    };
  }

  routingInstructionState.set(key, initial);
  return initial;
}

function isRoutingStateEmpty(state: RoutingInstructionState): boolean {
  if (!state) {
    return true;
  }
  const noForced = !state.forcedTarget;
  const noSticky = !state.stickyTarget;
  const noPrefer = !state.preferTarget;
  const noAllowed = state.allowedProviders.size === 0;
  const noDisabledProviders = state.disabledProviders.size === 0;
  const noDisabledKeys = state.disabledKeys.size === 0;
  const noDisabledModels = state.disabledModels.size === 0;
  const noStopMessage =
    (!state.stopMessageText || !state.stopMessageText.trim()) &&
    (typeof state.stopMessageMaxRepeats !== 'number' || !Number.isFinite(state.stopMessageMaxRepeats)) &&
    (typeof state.stopMessageUsed !== 'number' || !Number.isFinite(state.stopMessageUsed)) &&
    (typeof state.stopMessageStageMode !== 'string' || !state.stopMessageStageMode.trim()) &&
    (typeof state.stopMessageAiMode !== 'string' || !state.stopMessageAiMode.trim());
  const noPreCommand =
    (!state.preCommandScriptPath || !state.preCommandScriptPath.trim()) &&
    (typeof state.preCommandUpdatedAt !== 'number' || !Number.isFinite(state.preCommandUpdatedAt));
  return (
    noForced &&
    noSticky &&
    noPrefer &&
    noAllowed &&
    noDisabledProviders &&
    noDisabledKeys &&
    noDisabledModels &&
    noStopMessage &&
    noPreCommand
  );
}

export function persistRoutingInstructionState(
  key: string,
  state: RoutingInstructionState,
  routingStateStore: RoutingInstructionStateStoreLike
): void {
  if (!isPersistentScopeKey(key)) {
    return;
  }
  const supportsSync = typeof routingStateStore.saveSync === 'function';
  const shouldUseSyncForSession = supportsSync && (
    key.startsWith('session:')
    || key.startsWith('tmux:')
  );
  const prefersSync =
    supportsSync &&
    (
      key.startsWith('session:')
      || key.startsWith('tmux:')
    ) &&
    (Boolean(state.stopMessageText && state.stopMessageText.trim()) ||
      (typeof state.stopMessageMaxRepeats === 'number' && Number.isFinite(state.stopMessageMaxRepeats)) ||
    (typeof state.stopMessageUsed === 'number' && Number.isFinite(state.stopMessageUsed)) ||
    Boolean(state.stopMessageStageMode && state.stopMessageStageMode.trim()) ||
    Boolean(state.stopMessageAiMode && state.stopMessageAiMode.trim()) ||
    Boolean(state.preCommandScriptPath && state.preCommandScriptPath.trim()) ||
    (typeof state.preCommandUpdatedAt === 'number' && Number.isFinite(state.preCommandUpdatedAt)));
  if (isRoutingStateEmpty(state)) {
    // For session scope, clear must be sync to avoid stale persisted snapshots
    // being reloaded immediately by same-request readers.
    if (shouldUseSyncForSession) {
      routingStateStore.saveSync!(key, null);
    } else {
      routingStateStore.saveAsync(key, null);
    }
    return;
  }
  if (prefersSync) {
    routingStateStore.saveSync!(key, state);
  } else {
    routingStateStore.saveAsync(key, state);
  }
}
