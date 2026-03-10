import type { DetourEntry, DetourState } from '../types/chat-schema.js';
import type { HubDirection } from './hub-context.js';
import type { NativeReqInboundSemanticLiftApplyInput } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type DetourRegistryNativeEnvelope = NativeReqInboundSemanticLiftApplyInput['chatEnvelope'];

export class DetourRegistry {
  private readonly inbound: DetourEntry[] = [];
  private readonly outbound: DetourEntry[] = [];

  add(direction: HubDirection, entry: DetourEntry): void {
    if (direction === 'inbound') {
      this.inbound.push(entry);
      return;
    }
    this.outbound.push(entry);
  }

  snapshot(): DetourState {
    return {
      inbound: [...this.inbound],
      outbound: [...this.outbound]
    };
  }

  drain(direction: HubDirection): readonly DetourEntry[] {
    if (direction === 'inbound') {
      return [...this.inbound];
    }
    return [...this.outbound];
  }
}
