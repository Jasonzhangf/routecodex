export type InternalDebugErrorLane = 'request' | 'response' | 'other';
export type InternalDebugErrorCode = `500-${number}`;
export type InternalDebugErrorSeverity = 'error' | 'fatal' | 'policy_violation';
export type InternalDebugErrorClientExposure = 'never' | 'debug_endpoint_only';
export type InternalDebugErrorExternalLinkPolicy = 'none' | 'optional' | 'required';
export type InternalDebugErrorStatus = 'active' | 'reserved' | 'retired';

export interface InternalErrorCodeRegistryEntry {
  code: InternalDebugErrorCode;
  lane: InternalDebugErrorLane;
  nodeId: string;
  ownerFeatureId: string;
  moduleBlock: string;
  title: string;
  description: string;
  severity: InternalDebugErrorSeverity;
  allowedSourceFiles: readonly string[];
  externalLinkPolicy: InternalDebugErrorExternalLinkPolicy;
  clientExposure: InternalDebugErrorClientExposure;
  status: InternalDebugErrorStatus;
}

export interface InternalDebugErrorRegistry {
  entries: readonly InternalErrorCodeRegistryEntry[];
  byCode: ReadonlyMap<InternalDebugErrorCode, InternalErrorCodeRegistryEntry>;
}

const CODE_PATTERN = /^500-([123])(\d{2})$/;

export const INTERNAL_ERROR_NUMBERING_FEATURE_ID = 'feature_id: debug.internal_error_numbering';

export const INTERNAL_ERROR_CODE_REGISTRY_ENTRIES: readonly InternalErrorCodeRegistryEntry[] = [
  {
    code: '500-100',
    lane: 'request',
    nodeId: 'ServerReqInbound01ClientRaw',
    ownerFeatureId: 'server.responses_request_handler_bridge_surface',
    moduleBlock: '500-10x',
    title: 'server request adapter internal failure',
    description: 'RouteCodex-owned request adapter invariant or local processing failure before Hub inbound standardization.',
    severity: 'error',
    allowedSourceFiles: ['src/server/handlers', 'src/server/runtime/http-server'],
    externalLinkPolicy: 'optional',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-110',
    lane: 'request',
    nodeId: 'HubReqInbound02Standardized',
    ownerFeatureId: 'hub.req_inbound_responses_context_capture',
    moduleBlock: '500-11x',
    title: 'hub request inbound standardization internal failure',
    description: 'RouteCodex-owned failure while preserving and standardizing request semantics at Hub inbound.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core', 'src/modules/llmswitch/bridge'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-120',
    lane: 'request',
    nodeId: 'HubReqChatProcess03Governed',
    ownerFeatureId: 'hub.req_chatprocess_governance',
    moduleBlock: '500-12x',
    title: 'hub request chat-process governance internal failure',
    description: 'RouteCodex-owned failure inside request-side Chat Process governance.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-130',
    lane: 'request',
    nodeId: 'VrRoute04SelectedTarget',
    ownerFeatureId: 'vr.provider_forwarder_runtime',
    moduleBlock: '500-13x',
    title: 'virtual router selection internal failure',
    description: 'RouteCodex-owned Virtual Router selection or route availability invariant failure.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine'],
    externalLinkPolicy: 'optional',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-140',
    lane: 'request',
    nodeId: 'HubReqOutbound05ProviderSemantic',
    ownerFeatureId: 'hub.req_outbound_provider_semantic',
    moduleBlock: '500-14x',
    title: 'hub request outbound semantic internal failure',
    description: 'RouteCodex-owned failure while building provider semantic request truth.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-150',
    lane: 'request',
    nodeId: 'ProviderReqOutbound06WirePayload',
    ownerFeatureId: 'error.pipeline_contract',
    moduleBlock: '500-15x',
    title: 'provider outbound wire payload internal failure',
    description: 'RouteCodex-owned provider runtime/outbound codec failure, not an upstream provider status.',
    severity: 'error',
    allowedSourceFiles: ['src/providers', 'sharedmodule/llmswitch-core'],
    externalLinkPolicy: 'optional',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-200',
    lane: 'response',
    nodeId: 'ProviderRespInbound01Raw',
    ownerFeatureId: 'error.pipeline_contract',
    moduleBlock: '500-20x',
    title: 'provider inbound raw response internal failure',
    description: 'RouteCodex-owned failure while receiving or staging provider raw response bytes.',
    severity: 'error',
    allowedSourceFiles: ['src/providers', 'src/server/runtime/http-server/executor'],
    externalLinkPolicy: 'required',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-210',
    lane: 'response',
    nodeId: 'HubRespInbound02Parsed',
    ownerFeatureId: 'hub.response_provider_sse_materialization',
    moduleBlock: '500-21x',
    title: 'hub response inbound parse internal failure',
    description: 'RouteCodex-owned response parsing/materialization failure after provider raw response.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core', 'src/modules/llmswitch/bridge'],
    externalLinkPolicy: 'optional',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-220',
    lane: 'response',
    nodeId: 'HubRespChatProcess03Governed',
    ownerFeatureId: 'hub.servertool_followup',
    moduleBlock: '500-22x',
    title: 'hub response chat-process governance internal failure',
    description: 'RouteCodex-owned response-side Chat Process governance failure.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-230',
    lane: 'response',
    nodeId: 'HubRespOutbound04ClientSemantic',
    ownerFeatureId: 'hub.response_responses_client_projection',
    moduleBlock: '500-23x',
    title: 'hub response outbound client semantic internal failure',
    description: 'RouteCodex-owned failure while projecting governed response semantics to the client protocol.',
    severity: 'error',
    allowedSourceFiles: ['sharedmodule/llmswitch-core', 'src/modules/llmswitch/bridge'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-240',
    lane: 'response',
    nodeId: 'ServerRespOutbound05ClientFrame',
    ownerFeatureId: 'server.responses_response_handler_bridge_surface',
    moduleBlock: '500-24x',
    title: 'server response frame internal failure',
    description: 'RouteCodex-owned failure while writing final HTTP/SSE client frames.',
    severity: 'error',
    allowedSourceFiles: ['src/server/handlers', 'src/server/runtime/http-server'],
    externalLinkPolicy: 'optional',
    clientExposure: 'never',
    status: 'active',
  },
  {
    code: '500-300',
    lane: 'other',
    nodeId: 'DebugObs05HarnessExecuted',
    ownerFeatureId: 'debug.unified_surface',
    moduleBlock: '500-30x',
    title: 'debug artifact projection internal failure',
    description: 'RouteCodex-owned debug artifact, snapshot, harness, or policy observation failure.',
    severity: 'error',
    allowedSourceFiles: ['src/debug'],
    externalLinkPolicy: 'optional',
    clientExposure: 'debug_endpoint_only',
    status: 'active',
  },
  {
    code: '500-310',
    lane: 'other',
    nodeId: 'MetaReq01ClientContextSeen',
    ownerFeatureId: 'hub.metadata_center_mainline',
    moduleBlock: '500-31x',
    title: 'metadata center internal boundary failure',
    description: 'RouteCodex-owned MetadataCenter boundary or lifecycle invariant failure.',
    severity: 'policy_violation',
    allowedSourceFiles: ['src/server/runtime/http-server/metadata-center', 'sharedmodule/llmswitch-core'],
    externalLinkPolicy: 'none',
    clientExposure: 'never',
    status: 'active',
  },
];

function expectedLaneForCode(code: string): InternalDebugErrorLane {
  const match = CODE_PATTERN.exec(code);
  if (!match) {
    throw new Error(`invalid internal debug error code format: ${code}`);
  }
  if (match[1] === '1') return 'request';
  if (match[1] === '2') return 'response';
  return 'other';
}

function validateEntry(entry: InternalErrorCodeRegistryEntry): void {
  const lane = expectedLaneForCode(entry.code);
  if (lane !== entry.lane) {
    throw new Error(`internal debug error code ${entry.code} belongs to ${lane}, not ${entry.lane}`);
  }
  if (!entry.nodeId.trim()) {
    throw new Error(`internal debug error code ${entry.code} missing nodeId`);
  }
  if (!entry.ownerFeatureId.trim()) {
    throw new Error(`internal debug error code ${entry.code} missing ownerFeatureId`);
  }
  if (!entry.moduleBlock.trim()) {
    throw new Error(`internal debug error code ${entry.code} missing moduleBlock`);
  }
  if (!entry.allowedSourceFiles.length) {
    throw new Error(`internal debug error code ${entry.code} missing allowedSourceFiles`);
  }
}

export function createInternalDebugErrorRegistry(
  entries: readonly InternalErrorCodeRegistryEntry[] = INTERNAL_ERROR_CODE_REGISTRY_ENTRIES,
): InternalDebugErrorRegistry {
  const byCode = new Map<InternalDebugErrorCode, InternalErrorCodeRegistryEntry>();
  const activeNodeTitles = new Set<string>();
  for (const entry of entries) {
    validateEntry(entry);
    if (byCode.has(entry.code)) {
      throw new Error(`duplicate internal debug error code: ${entry.code}`);
    }
    if (entry.status === 'active') {
      const activeKey = `${entry.nodeId}::${entry.title}`;
      if (activeNodeTitles.has(activeKey)) {
        throw new Error(`duplicate active internal debug error title for node ${entry.nodeId}: ${entry.title}`);
      }
      activeNodeTitles.add(activeKey);
    }
    byCode.set(entry.code, entry);
  }
  return { entries, byCode };
}

export function resolveInternalDebugErrorCode(
  code: InternalDebugErrorCode,
  registry: InternalDebugErrorRegistry = createInternalDebugErrorRegistry(),
): InternalErrorCodeRegistryEntry {
  const entry = registry.byCode.get(code);
  if (!entry) {
    throw new Error(`unknown internal debug error code: ${code}`);
  }
  if (entry.status === 'retired') {
    throw new Error(`retired internal debug error code cannot be used: ${code}`);
  }
  return entry;
}

export function resolveInternalDebugErrorModuleBlock(
  code: InternalDebugErrorCode,
  registry?: InternalDebugErrorRegistry,
): string {
  return resolveInternalDebugErrorCode(code, registry).moduleBlock;
}

export function resolveInternalDebugErrorCodeForNodeId(
  nodeId: string,
  registry: InternalDebugErrorRegistry = createInternalDebugErrorRegistry(),
): InternalDebugErrorCode {
  const trimmedNodeId = nodeId.trim();
  if (!trimmedNodeId) {
    throw new Error('internal debug error nodeId is required');
  }
  const matches = registry.entries.filter((entry) => entry.status === 'active' && entry.nodeId === trimmedNodeId);
  if (matches.length === 0) {
    throw new Error(`unknown internal debug error nodeId: ${trimmedNodeId}`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous internal debug error nodeId: ${trimmedNodeId}`);
  }
  return matches[0].code;
}

export function assignInternalDebugErrorSubcode(
  code: InternalDebugErrorCode,
  registry?: InternalDebugErrorRegistry,
): InternalErrorCodeRegistryEntry {
  return resolveInternalDebugErrorCode(code, registry);
}
