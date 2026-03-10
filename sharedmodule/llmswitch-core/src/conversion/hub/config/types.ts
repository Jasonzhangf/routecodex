export type MappingDirection = 'inbound' | 'outbound';

export interface FieldMapping {
  readonly id: string;
  readonly target: string;
  readonly path: string;
  readonly description: string;
  readonly required?: boolean;
  readonly transformNotes?: string;
}

export interface FormatMappingConfig {
  readonly description: string;
  readonly inbound: readonly FieldMapping[];
  readonly outbound: readonly FieldMapping[];
}

export interface SemanticRule {
  readonly id: string;
  readonly appliesTo: MappingDirection | 'both';
  readonly description: string;
  readonly notes?: string;
}

export interface ProtocolConfigDocument {
  readonly protocol: string;
  readonly specReference: string;
  readonly format: FormatMappingConfig;
  readonly semanticRules: readonly SemanticRule[];
}
