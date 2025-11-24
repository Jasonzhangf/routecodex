export type PipelinePhase = 'request' | 'response';

export type PipelineNodeKind =
  | 'sse-input'
  | 'input'
  | 'process'
  | 'compatibility'
  | 'provider'
  | 'output'
  | 'sse-output';

export interface PipelineNodeDescriptor {
  id: string;
  kind: PipelineNodeKind;
  implementation: string;
  options?: Record<string, unknown>;
}

export interface PipelineDescriptor {
  id: string;
  name?: string;
  entryEndpoints: string[];
  providerProtocols?: string[];
  processMode?: string;
  mode?: string;
  streaming?: 'auto' | 'always' | 'never';
  nodes: PipelineNodeDescriptor[];
}

export interface PipelineConfigDocument {
  pipelineConfigVersion?: string;
  generatedAt?: string;
  pipelines: PipelineDescriptor[];
}

export interface PipelineBlueprint {
  id: string;
  name?: string;
  phase: PipelinePhase;
  entryEndpoints: string[];
  providerProtocols: string[];
  processMode: 'chat' | 'passthrough';
  streaming: 'auto' | 'always' | 'never';
  nodes: PipelineNodeDescriptor[];
}

export interface ResolveOptions {
  phase?: PipelinePhase;
  providerProtocol?: string;
  processMode?: 'chat' | 'passthrough';
}
