import type { ManagerContext, ManagerModule } from '../../types.js';
// feature_id: manager.routing_control_surface
// canonical_builders: load_routing_instruction_state, persist_routing_instruction_state
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} from '../../../modules/llmswitch/bridge.js';

type RoutingInstructionState = unknown;

export interface RoutingInstructionStateStore {
  loadSync(key: string): RoutingInstructionState | null;
  saveAsync(key: string, state: RoutingInstructionState | null): void;
  saveSync?(key: string, state: RoutingInstructionState | null): void;
}

export class RoutingStateManagerModule implements ManagerModule {
  readonly id = 'routing';

  private stateStore: RoutingInstructionStateStore | null = null;

  async init(_context: ManagerContext): Promise<void> {
    // Single import surface: llmswitch-core routing state store is accessed via llmswitch bridge only.
    this.stateStore = {
      loadSync: (key: string) => loadRoutingInstructionStateSync(key) as RoutingInstructionState | null,
      saveAsync: (key: string, state: RoutingInstructionState | null) => {
        saveRoutingInstructionStateAsync(key, state as RoutingInstructionState | null);
      },
      saveSync: (key: string, state: RoutingInstructionState | null) => {
        saveRoutingInstructionStateSync(key, state as RoutingInstructionState | null);
      },
    };
  }

  async start(): Promise<void> {
    // 当前 RoutingStateManager 仅提供 routingStateStore，不需要后台任务。
  }

  async stop(): Promise<void> {
    // 未来如需 compact/迁移 routing state，可在此添加逻辑；当前为 no-op。
  }

  getRoutingStateStore(): RoutingInstructionStateStore | null {
    return this.stateStore;
  }
}
