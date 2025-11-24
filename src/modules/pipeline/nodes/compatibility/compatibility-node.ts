import type { PipelineNode } from '../../orchestrator/pipeline-node.js';
import type { PipelineContext } from '../../orchestrator/pipeline-context.js';
import type { PipelineNodeDescriptor } from '../../orchestrator/types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { PipelineSnapshotRecorder } from '../../utils/pipeline-snapshot-recorder.js';

type CompatibilityDirection = 'request' | 'response';

interface CompatibilityNodeOptions {
  compatibility?: {
    direction?: CompatibilityDirection;
    profile?: string;
    providerMatch?: string[];
    protocolMatch?: string[];
  };
}

export class CompatibilityProcessNode implements PipelineNode {
  readonly id: string;
  readonly descriptor: PipelineNodeDescriptor;
  private readonly direction: CompatibilityDirection;
  private readonly providerMatch?: Set<string>;
  private readonly protocolMatch?: Set<string>;

  constructor(descriptor: PipelineNodeDescriptor) {
    this.id = descriptor.id;
    this.descriptor = descriptor;
    const options = this.normalizeOptions(descriptor.options);
    this.direction = options.direction;
    this.providerMatch = options.providerMatch;
    this.protocolMatch = options.protocolMatch;
  }

  async execute(context: PipelineContext): Promise<void> {
    if (context.phase !== this.direction) {
      await context.reportNodeWarning(this.descriptor, `compatibility node direction mismatch (${this.direction}) - skipping`);
      return;
    }
    if (!this.shouldExecute(context)) {
      return;
    }
    const pipeline = context.extra['pipelineInstance'] as { runCompatibilityRequest?: Function; runCompatibilityResponse?: Function } | undefined;
    if (!pipeline) {
      throw new Error('[CompatibilityProcessNode] pipelineInstance missing in context');
    }
    const snapshotRecorder = context.extra['snapshotRecorder'] as PipelineSnapshotRecorder | undefined;
    if (this.direction === 'request') {
      if (!context.request) {
        throw new Error('[CompatibilityProcessNode] request payload missing');
      }
      const fn = typeof pipeline.runCompatibilityRequest === 'function'
        ? pipeline.runCompatibilityRequest.bind(pipeline)
        : null;
      if (!fn) {
        throw new Error('[CompatibilityProcessNode] pipeline does not expose runCompatibilityRequest');
      }
      const next = await fn(context.request as SharedPipelineRequest, snapshotRecorder, this.descriptor.options);
      context.request = next;
      return;
    }

    if (!context.response) {
      throw new Error('[CompatibilityProcessNode] response payload missing');
    }
    const fn = typeof pipeline.runCompatibilityResponse === 'function'
      ? pipeline.runCompatibilityResponse.bind(pipeline)
      : null;
    if (!fn) {
      throw new Error('[CompatibilityProcessNode] pipeline does not expose runCompatibilityResponse');
    }
    const next = await fn(context.response as SharedPipelineResponse, snapshotRecorder, this.descriptor.options);
    context.response = next;
  }

  private shouldExecute(context: PipelineContext): boolean {
    const providerId = context.metadata.providerId?.toLowerCase();
    if (this.providerMatch && providerId && !this.providerMatch.has(providerId)) {
      return false;
    }
    const protocol = context.metadata.providerProtocol?.toLowerCase();
    if (this.protocolMatch && protocol && !this.protocolMatch.has(protocol)) {
      return false;
    }
    return true;
  }

  private normalizeOptions(raw?: Record<string, unknown>): {
    direction: CompatibilityDirection;
    providerMatch?: Set<string>;
    protocolMatch?: Set<string>;
  } {
    const opts = (raw as CompatibilityNodeOptions | undefined)?.compatibility || {};
    const direction = (opts.direction === 'response' ? 'response' : 'request') as CompatibilityDirection;
    const providerMatch = Array.isArray(opts.providerMatch)
      ? new Set(opts.providerMatch.map((id) => (typeof id === 'string' ? id.toLowerCase() : '')).filter(Boolean))
      : undefined;
    const protocolMatch = Array.isArray(opts.protocolMatch)
      ? new Set(opts.protocolMatch.map((id) => (typeof id === 'string' ? id.toLowerCase() : '')).filter(Boolean))
      : undefined;
    return {
      direction,
      providerMatch,
      protocolMatch
    };
  }
}
